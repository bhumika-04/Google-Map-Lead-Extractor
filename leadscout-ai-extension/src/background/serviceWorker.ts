import { MSG } from '@/types/messages'
import type {
  SearchStartPayload,
  SearchQueueStartPayload,
  SearchQueueProgress,
  LeadFoundPayload,
  CaptureProgressPayload,
  CaptureFinishedPayload,
  ProgressUpdatePayload,
} from '@/types/messages'
import type { Lead } from '@/types/lead'
import { searchSessionRepository } from '@/db/searchSessionRepository'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { leadRepository } from '@/db/leadRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { isDuplicate, mergeLeadData } from '@/utils/dedupe'
import { normalizeName } from '@/utils/normalize'
import { nowISO } from '@/utils/date'
import { openDashboard } from '@/services/chromeMessaging'
import { processNextJob } from '@/services/researchService'
import { sweepOrphanScraperTabs } from '@/services/socialScraper'
import { addToResearchQueue } from '@/services/futureResearchService'
import { discoverLeads } from '@/services/directoryDiscovery'
import { syncToSql, isApiAvailable, fetchApiConfig, restoreFromSql, saveLeadBatchToSql, saveValidationBulkToSql, createSearchRunInSql, updateSearchRunInSql, fetchSearchRuns } from '@/services/sqlSyncService'
import { pushBackup } from '@/services/backupSyncService'
import { runAutoValidationAndResearch } from '@/services/autoPipelineService'
// Dual-write to the redesigned schema (sessions + scrapedLeads) — mirrors capture
// into the new tables without disturbing the proven legacy capture path.
import { sessionRepository } from '@/db/sessionRepository'
import { scrapedLeadRepo } from '@/db/pipelineLeadRepository'
import { createSessionInSql, saveLeadBatchToSql as savePipelineBatchToSql } from '@/services/pipelineSyncService'
import { verifyLeadsFromGoogle } from '@/services/googleVerifyService'
import { reconcileScrapedForLeads } from '@/services/scrapedReconcileService'
import type { ScrapedLead } from '@/types/pipelineLead'
import type { SessionRecord } from '@/types/session'
import { researchResultRepository } from '@/db/researchResultRepository'
import { db } from '@/db/db'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_SETTINGS } from '@/types/settings'
import { getCampaign, updateCampaign } from '@/services/batchCampaignService'
import { getDueSequences, markSequenceSent } from '@/services/nurtureService'
import { existingClientRepository } from '@/db/existingClientRepository'
import {
  getLiJob, startLiScraperJob, ingestStepData, cancelLiJob,
  urlMatchesStep, stepUrl, dequeueLiScrape,
} from '@/services/linkedinScraperService'
import type { DeepResearch, PersonActivity, SocialPost } from '@/types/deepResearch'
import type { LinkedInScraperJob } from '@/types/linkedinData'

// ─── Session state (ephemeral, in memory) ─────────────────────────────────────

// The one Maps tab reused across sequential searches — survives past
// activeSession (which is nulled on capture finish) so the next term in a
// queue can navigate the same tab instead of opening another.
let lastMapsTabId: number | null = null

interface ActiveSession {
  sessionId: number
  mapsTabId: number
  city: string
  keyword: string
  country: string
  searchQuery: string
  maxResults: number
  totalCaptured: number
  duplicatesSkipped: number
  status: string
  projectId?: number    // Search Session this capture belongs to — stamped on every lead
  mssqlRunId?: number   // MSSQL search_runs.id — sent with lead batch saves
  // Dual-write mirror targets (redesigned schema)
  scrapedSessionId?: number
  scrapedSessionMssqlId?: number
}

// Map a legacy Lead to the redesigned scraped_leads shape for the dual-write mirror.
function toScrapedLead(l: Omit<Lead, 'id'>, sessionId: number): Omit<ScrapedLead, 'id'> {
  const now = nowISO()
  return {
    sessionId,
    companyName: l.companyName,
    normalizedName: l.normalizedName,
    category: l.category,
    rating: l.rating,
    reviewCount: l.reviewCount,
    address: l.address,
    phone: l.phone,
    website: l.website,
    googleMapsUrl: l.googleMapsUrl,
    city: l.city,
    keyword: l.keyword,
    country: l.country,
    status: 'new',
    enrichmentStatus: 'pending',
    researchStatus: 'none',
    capturedAt: l.capturedAt ?? now,
    updatedAt: now,
  }
}

let activeSession: ActiveSession | null = null
let dashboardTabId: number | null = null
let cachedSettings: AppSettings | null = null

// ─── Batch campaign state (in memory — persisted to IndexedDB on every change) ──
let activeBatchCampaignId: number | null = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

function broadcastProgress(payload: ProgressUpdatePayload) {
  if (dashboardTabId !== null) {
    chrome.tabs.sendMessage(dashboardTabId, { type: MSG.PROGRESS_UPDATE, payload }).catch(() => {})
  }
  updateBadge(payload.totalCaptured, payload.status)
}

// Brings the dashboard tab back to the front once scraping is done, so the user
// isn't left staring at the Google Maps tab after a search/campaign finishes.
async function focusDashboardTab() {
  if (dashboardTabId === null) return
  try {
    const tab = await chrome.tabs.update(dashboardTabId, { active: true })
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
  } catch {
    // Dashboard tab was closed — nothing to focus.
    dashboardTabId = null
  }
}

// Auto-runs validation (and queues research for the top relevant leads) right after
// scraping finishes. Lives here — not in a dashboard page component — because the
// service worker is the only context guaranteed to be alive when capture ends; the
// user should never have to have a specific dashboard tab/page open for this to fire.
// ─── Pipeline control + persisted status ──────────────────────────────────────
// The auto-pipeline (enrichment → validation → research) runs in this worker so
// it survives page navigation. Two problems it must handle: (1) MV3 kills an idle
// worker mid-run — a keepalive alarm holds it up; (2) the user wants Stop / Re-run
// — a stop flag in storage is checked between leads, and status is persisted so any
// page can show it and offer a Re-run button.
const PIPELINE_KEEPALIVE = 'pipeline-keepalive'

interface PipelineState {
  status: 'idle' | 'running' | 'stopped' | 'done'
  phase?: string
  processed: number
  total: number
  projectId?: number   // which session this run is scoped to (undefined = all)
  updatedAt: number
}

async function setPipelineState(patch: Partial<PipelineState>) {
  const cur: PipelineState = (await chrome.storage.local.get('pipeline_state')).pipeline_state
    ?? { status: 'idle', processed: 0, total: 0, updatedAt: 0 }
  await chrome.storage.local.set({ pipeline_state: { ...cur, ...patch, updatedAt: Date.now() } })
}

async function isPipelineStopRequested(): Promise<boolean> {
  return !!(await chrome.storage.local.get('pipeline_stop')).pipeline_stop
}

let pipelineRunning = false

async function runPipeline(projectId?: number, force = false) {
  if (pipelineRunning) return
  const settings = await loadSettingsForResearch()

  pipelineRunning = true
  await chrome.storage.local.set({ pipeline_stop: false })
  await setPipelineState({ status: 'running', phase: 'starting', processed: 0, total: 0, projectId })
  chrome.alarms.create(PIPELINE_KEEPALIVE, { periodInMinutes: 0.4 }) // hold the worker up mid-run

  const lastSession = activeSession
  const onPhaseChange = (phase: string) => {
    setPipelineState({ phase }).catch(() => {})
    broadcastProgress({
      sessionId: lastSession?.sessionId ?? 0,
      totalCaptured: lastSession?.totalCaptured ?? 0,
      duplicatesSkipped: lastSession?.duplicatesSkipped ?? 0,
      status: 'completed',
      pipelinePhase: phase,
    })
  }
  const onProgress = (done: number, total: number) => { setPipelineState({ processed: done, total }).catch(() => {}) }
  const shouldStop = () => isPipelineStopRequested()

  try {
    await runAutoValidationAndResearch(settings, { onPhaseChange, onProgress, shouldStop, projectId, force })
    await setPipelineState({ status: (await isPipelineStopRequested()) ? 'stopped' : 'done' })
  } catch (err) {
    console.error('[pipeline] failed:', err)
    await setPipelineState({ status: 'stopped' })
  } finally {
    pipelineRunning = false
    chrome.alarms.clear(PIPELINE_KEEPALIVE).catch(() => {})
  }
}

async function maybeRunAutoPipeline() {
  const settings = await loadSettingsForResearch()
  if (!settings.autoValidate) return
  runPipeline().catch(() => {})
}

// On-demand "Verify from Google" — replaces estimated turnover/team size with
// exact values via Google AI mode. Reuses the pipeline status/keepalive/stop UI.
async function runVerifyFromGoogle(projectId?: number) {
  if (pipelineRunning) return
  pipelineRunning = true
  await chrome.storage.local.set({ pipeline_stop: false })
  chrome.alarms.create(PIPELINE_KEEPALIVE, { periodInMinutes: 0.4 })

  try {
    let leads = await leadRepository.getAll()
    if (projectId !== undefined) leads = leads.filter((l) => (l.projectId ?? -1) === projectId)
    // Only leads that still have estimated (unverified) turnover or team size.
    const targets = leads.filter((l) => !l.turnoverVerified || !l.teamSizeVerified)
    await setPipelineState({ status: 'running', phase: 'verifying', processed: 0, total: targets.length, projectId })

    const updated = await verifyLeadsFromGoogle(targets, {
      onProgress: (done, total) => { setPipelineState({ processed: done, total }).catch(() => {}) },
      shouldStop: () => isPipelineStopRequested(),
    })
    reconcileScrapedForLeads(targets, 'enrichment').catch(() => {})
    await setPipelineState({ status: (await isPipelineStopRequested()) ? 'stopped' : 'done' })
    await log('system', `Verify from Google: ${updated} leads updated with exact values`).catch(() => {})
  } catch (err) {
    console.error('[verify] failed:', err)
    await setPipelineState({ status: 'stopped' })
  } finally {
    pipelineRunning = false
    chrome.alarms.clear(PIPELINE_KEEPALIVE).catch(() => {})
  }
}

function updateBadge(count: number, status: string) {
  if (status === 'running' || status === 'opening_maps') {
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '●' })
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' })
  } else if (status === 'completed') {
    chrome.action.setBadgeText({ text: String(count) })
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' })
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 8000)
  } else {
    chrome.action.setBadgeText({ text: '' })
  }
}

async function log(type: string, message: string, sessionId?: number, meta?: Record<string, unknown>) {
  await activityLogRepository.log(type, message, sessionId, meta)
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSearchStart(payload: SearchStartPayload, senderTabId?: number) {
  dashboardTabId = senderTabId ?? dashboardTabId

  await log('search_started', `Search started: ${payload.city} — ${payload.keyword}`, payload.sessionId)

  // Update session status to opening_maps
  await searchSessionRepository.updateStatus(payload.sessionId, 'opening_maps')

  broadcastProgress({
    sessionId: payload.sessionId,
    totalCaptured: 0,
    duplicatesSkipped: 0,
    status: 'opening_maps',
    message: 'Opening Google Maps...',
  })

  // Reuse the previous search's Maps tab when it still exists. A long
  // sequential run (Search Console queues hundreds of keyword×city terms)
  // opened a fresh tab per term and never closed the old one — hundreds of
  // Maps tabs piled up, Chrome slowed to a crawl, and Google started serving
  // rate-limit/forbidden pages instead of results (captures ending with 0
  // leads). Navigating one persistent tab keeps the whole run in a single tab.
  let tab: chrome.tabs.Tab | undefined
  if (lastMapsTabId !== null) {
    tab = await chrome.tabs
      .update(lastMapsTabId, { url: payload.mapsUrl, active: true })
      .catch(() => undefined) // tab was closed meanwhile — fall through to create
  }

  // No reusable tab — open a new one. Retry on the transient "Tabs cannot be
  // edited right now (user may be dragging a tab)" error rather than failing
  // the whole keyword search outright. This condition only lasts while the
  // user is mid-drag, so a short backoff resolves it; without a retry, that
  // one keyword search was silently skipped entirely (auto-advance moves to
  // the next keyword regardless).
  if (!tab) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        tab = await chrome.tabs.create({ url: payload.mapsUrl, active: true })
        break
      } catch (err: any) {
        if (attempt === 3 || !/dragging a tab/i.test(err?.message ?? '')) throw err
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }
  const mapsTabId = tab!.id!
  lastMapsTabId = mapsTabId

  await log('maps_tab_opened', `Maps tab opened: ${payload.mapsUrl}`, payload.sessionId)

  // Resolve the Search Session (project) this capture belongs to. The MSSQL
  // run id is created lazily here if the API was down when the project was
  // created, so lead batch saves can always carry their run tag.
  let mssqlRunId: number | undefined
  let scrapedSessionId: number | undefined
  let scrapedSessionMssqlId: number | undefined
  if (payload.projectId !== undefined) {
    const project = await searchProjectRepository.getById(payload.projectId).catch(() => undefined)
    if (project) {
      if (project.mssqlRunId === undefined) {
        const runId = await createSearchRunInSql(project).catch(() => null)
        if (runId !== null) {
          await searchProjectRepository.update(project.id!, { mssqlRunId: runId }).catch(() => {})
          project.mssqlRunId = runId
        }
      }
      mssqlRunId = project.mssqlRunId

      // Dual-write: ensure a redesigned-schema `session` mirrors this project, so
      // capture also populates sessions + scrapedLeads (+ new API), without
      // touching the legacy leads path below.
      if (project.newSessionId) {
        scrapedSessionId = project.newSessionId
        scrapedSessionMssqlId = project.newSessionMssqlId
      } else {
        const rec: SessionRecord = {
          name: project.name, source: 'scrape', country: project.country,
          keywords: project.keywords ?? [], cities: project.cities ?? [],
          businessProfile: project.businessProfile ?? '', status: 'running',
          totalLeads: 0, createdAt: nowISO(),
        }
        const sid = await sessionRepository.create(rec).catch(() => undefined)
        if (sid) {
          scrapedSessionId = sid
          const smid = await createSessionInSql({ ...rec, id: sid }).catch(() => null)
          scrapedSessionMssqlId = smid ?? undefined
          await searchProjectRepository.update(project.id!, { newSessionId: sid, newSessionMssqlId: smid ?? undefined }).catch(() => {})
        }
      }
    }
  }

  activeSession = {
    sessionId: payload.sessionId,
    mapsTabId,
    city: payload.city,
    keyword: payload.keyword,
    country: payload.country ?? 'IN',
    searchQuery: `${payload.keyword} in ${payload.city}`,
    maxResults: payload.maxResults,
    totalCaptured: 0,
    duplicatesSkipped: 0,
    status: 'running',
    projectId: payload.projectId,
    mssqlRunId,
    scrapedSessionId,
    scrapedSessionMssqlId,
  }

  // Cache settings once per session — avoids a DB read on every LEAD_FOUND message
  cachedSettings = await loadSettingsForResearch()

  // Wait for tab to finish loading, then inject start command
  const onUpdated = async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (tabId !== mapsTabId || changeInfo.status !== 'complete') return
    chrome.tabs.onUpdated.removeListener(onUpdated)

    await searchSessionRepository.updateStatus(payload.sessionId, 'running', { startedAt: nowISO() })
    await log('capture_started', 'Capture started on Google Maps', payload.sessionId)

    broadcastProgress({
      sessionId: payload.sessionId,
      totalCaptured: 0,
      duplicatesSkipped: 0,
      status: 'running',
      message: 'Capture started...',
    })

    // Wait for Maps JS to render results
    await new Promise((r) => setTimeout(r, 4000))

    chrome.tabs.sendMessage(mapsTabId, {
      type: MSG.MAPS_START_CAPTURE,
      payload: {
        sessionId: payload.sessionId,
        maxResults: payload.maxResults,
        settings: payload.settings,
      },
    }).catch(async () => {
      await log('capture_error', 'Failed to contact content script on Maps tab', payload.sessionId)
    })
  }

  chrome.tabs.onUpdated.addListener(onUpdated)
}

async function handleLeadFound(payload: LeadFoundPayload) {
  // Snapshot session into a local variable immediately. handleCaptureFinished sets
  // activeSession = null as its first action (to stop accepting new leads), but there
  // may be multiple LEAD_FOUND messages already queued in the event loop. Without this
  // snapshot, those in-flight messages would see null and silently drop the lead.
  const session = activeSession
  if (!session) return

  const lead = payload.lead as Omit<Lead, 'id'>

  lead.city        = lead.city        || session.city
  lead.keyword     = lead.keyword     || session.keyword
  lead.country     = lead.country     || session.country || 'IN'
  lead.searchQuery = lead.searchQuery || session.searchQuery
  lead.projectId   = session.projectId
  lead.normalizedName = normalizeName(lead.companyName)

  const candidates = await leadRepository.findCandidatesForDedupe(
    session.sessionId, lead.normalizedName, lead.phone, lead.googleMapsUrl
  )

  const existing = isDuplicate(lead, candidates)
  if (existing) {
    const patch = mergeLeadData(existing, lead)
    if (Object.keys(patch).length > 0) await leadRepository.patchMissingFields(existing.id!, patch)
    session.duplicatesSkipped++
    await searchSessionRepository.incrementDuplicates(session.sessionId)
    await log('duplicate_skipped', `Duplicate: ${lead.companyName}`, session.sessionId)
  } else {
    const id = await leadRepository.create(lead)
    session.totalCaptured++
    await searchSessionRepository.incrementCaptured(session.sessionId)
    await log('lead_captured', `Captured: ${lead.companyName}`, session.sessionId, { leadId: id })

    // Dual-write mirror → redesigned schema (sessions + scrapedLeads + new API).
    if (session.scrapedSessionId) {
      const sid = session.scrapedSessionId
      await scrapedLeadRepo.upsertCapture(sid, [toScrapedLead(lead, sid) as any]).catch(() => {})
      await sessionRepository.addLeads(sid, 1).catch(() => {})
      if (session.scrapedSessionMssqlId && session.totalCaptured % 10 === 0) {
        const recent = await scrapedLeadRepo.getBySession(sid)
        savePipelineBatchToSql('scraped', session.scrapedSessionMssqlId, recent as ScrapedLead[])
          .then(async (idMap) => {
            for (const r of recent) {
              const serverId = idMap[r.normalizedName]
              if (serverId && r.id && r.mssqlId !== serverId) await scrapedLeadRepo.update(r.id, { mssqlId: serverId })
            }
          })
          .catch(() => {})
      }
    }

    // Save to MSSQL every 10 leads — direct DB write, not just a backup
    if (session.totalCaptured % 10 === 0) {
      const recentLeads = await leadRepository.getByFilter({ sessionId: session.sessionId })
      saveLeadBatchToSql(session.city, session.keyword, recentLeads.map((l) => ({
        id: l.id!, companyName: l.companyName, address: l.address, phone: l.phone,
        website: l.website, googleMapsUrl: l.googleMapsUrl, rating: l.rating,
        reviewCount: l.reviewCount, category: l.category, city: l.city,
      })), session.mssqlRunId).catch(() => {
        // Surface this in Activity Logs — silent MSSQL sync failures during a
        // long capture session are exactly what caused a prior data-loss incident.
        log('system', `⚠️ MSSQL batch save failed at ${session.totalCaptured} leads — will retry next batch. Data is still safe in the local JSON backup.`, session.sessionId).catch(() => {})
      })
    }

    // Independent full-snapshot safety net — pushes ALL local data (not just this
    // session) to /api/extension-backup as a JSON blob, separate from the MSSQL
    // 'companies' table. Survives even if the MSSQL sync above is failing, and
    // survives a DELETE FROM companies (different storage entirely). Runs every
    // 25 leads — infrequent enough to not add capture overhead.
    if (session.totalCaptured % 25 === 0) {
      pushBackup().catch(() => {})
    }

    // Auto-research if enabled (uses session-cached settings)
    const hasResearchKey = cachedSettings?.researchProvider === 'gemini' ? !!cachedSettings?.geminiApiKey
      : cachedSettings?.researchProvider === 'openai' ? !!cachedSettings?.openAiApiKey
      : !!cachedSettings?.anthropicApiKey
    if (cachedSettings?.autoResearch && hasResearchKey) {
      const savedLead = await leadRepository.getById(id)
      if (savedLead) await addToResearchQueue(savedLead).catch(() => {})
    }
  }

  broadcastProgress({
    sessionId:          session.sessionId,
    totalCaptured:      session.totalCaptured,
    duplicatesSkipped:  session.duplicatesSkipped,
    status:             'running',
    message:            `${session.totalCaptured} leads captured`,
  })
}

// ─── MSSQL → IndexedDB sync (MSSQL is single source of truth) ────────────────
// UPSERTs leads — never clears the local table.
// Existing leads are matched by mssqlId (preferred) or normalizedName — their
// IndexedDB IDs are preserved so researchResults/researchJobs stay linked.
// New leads from MSSQL that don't exist locally are inserted.
// Research results are restored from full_result_json if the lead has no result yet.

async function syncLeadsFromMssql(): Promise<{ synced: number }> {
  const available = await isApiAvailable()
  if (!available) return { synced: 0 }

  const data = await restoreFromSql()
  if (!data?.companies?.length) {
    await log('system', 'MSSQL sync: API returned empty — local data unchanged')
    return { synced: 0 }
  }

  // ── Step 0: status ranking (used by the rank-guarded status merge below) ────
  const STATUS_RANK: Record<string, number> = {
    research_completed: 4,
    research_failed: 3, research_running: 3, research_pending: 3, selected: 3,
    rejected: 2, new: 1,
  }
  const allLeads = await leadRepository.getAll()

  // IMPORTANT: the reload sync is intentionally NON-DESTRUCTIVE — it only
  // UPSERTs/inserts, it must NEVER delete local leads.
  //
  // This path used to run a "Step 0 dedup" that grouped ALL local leads by
  // normalizedName+city (across every Search Session) and DELETED the extras on
  // every dashboard open. That silently wiped legitimately-separate leads — e.g.
  // the same company captured under two different sessions/keywords, or leads that
  // had not yet synced to MSSQL — turning a ~1,700-lead capture into ~800 after a
  // reload. Capture already dedupes within a session at save time (findCandidatesForDedupe
  // + isDuplicate + mergeLeadData), and the new Search Session model deliberately keeps
  // different runs separate, so collapsing across sessions here is both wrong and lossy.
  // Deduplication, if ever wanted, must be an explicit user action — not a silent
  // side effect of opening the dashboard.
  const deletedLocalIds = new Set<number>()
  const dedupedCount = 0

  // Build lookup maps: mssqlId → lead and (normalizedName|city) → lead
  const existingLeads = allLeads.filter(l => l.id && !deletedLocalIds.has(l.id))
  const byMssqlId    = new Map<string, Lead>()
  const byNameCity   = new Map<string, Lead>()
  for (const l of existingLeads) {
    if (l.mssqlId) byMssqlId.set(l.mssqlId, l)
    byNameCity.set(`${l.normalizedName}|${(l.city ?? '').toLowerCase()}`, l)
  }

  // ── Rebuild Search Sessions from MSSQL search_runs ──────────────────────────
  // Companies carry run_id; recreate any session missing locally (reinstall /
  // cleared IndexedDB) so restored leads land back in their own workspace
  // instead of all collapsing into "Unassigned".
  const remoteRuns = await fetchSearchRuns()
  const localProjects = await searchProjectRepository.getAll().catch(() => [])
  const runToLocalProject = new Map<number, number>()
  // Also index existing sessions by name+country so a remote run that isn't
  // linked by id can be matched to an existing local session and LINKED, rather
  // than spawning a phantom empty "0 keyword / 0 city" duplicate card. This both
  // heals orphaned runs from the old double-create race and keeps genuine
  // restores (after a data wipe) working.
  const nameCountryKey = (name?: string, country?: string) =>
    `${(name ?? '').trim().toLowerCase()}|${(country ?? '').toLowerCase()}`
  const projectByNameCountry = new Map<string, { id: number; mssqlRunId?: number }>()
  for (const p of localProjects) {
    if (p.mssqlRunId !== undefined && p.id) runToLocalProject.set(p.mssqlRunId, p.id)
    if (p.id) {
      const key = nameCountryKey(p.name, p.country)
      if (!projectByNameCountry.has(key)) projectByNameCountry.set(key, { id: p.id, mssqlRunId: p.mssqlRunId })
    }
  }
  let projectsRestored = 0
  for (const r of remoteRuns) {
    if (runToLocalProject.has(r.id)) continue

    // A local session with the same name+country already exists — link this run
    // to it instead of creating a duplicate card.
    const key = nameCountryKey(r.name, r.country)
    const existing = projectByNameCountry.get(key)
    if (existing) {
      runToLocalProject.set(r.id, existing.id)
      if (existing.mssqlRunId === undefined) {
        await searchProjectRepository.update(existing.id, { mssqlRunId: r.id }).catch(() => {})
        existing.mssqlRunId = r.id
      }
      continue
    }

    // Genuinely new (e.g. leads restored after a local wipe) — recreate the session.
    try {
      const pid = await searchProjectRepository.create({
        name: r.name,
        country: r.country ?? 'IN',
        keywords: [],
        cities: [],
        businessProfile: r.businessProfile ?? '',
        status: r.status === 'running' ? 'running' : r.status === 'stopped' ? 'stopped' : 'completed',
        totalTerms: 0,
        completedTerms: 0,
        totalLeads: r.totalLeads ?? 0,
        source: 'search_console',
        mssqlRunId: r.id,
      })
      runToLocalProject.set(r.id, pid)
      projectByNameCountry.set(key, { id: pid, mssqlRunId: r.id })
      projectsRestored++
    } catch { /* skip */ }
  }

  // ── Heal existing phantom duplicate sessions ────────────────────────────────
  // The old double-create race left orphan runs that the previous rebuild turned
  // into empty "0 keyword / 0 city / 0 leads" duplicate cards. Remove any such
  // empty session that (a) has no leads and (b) has a REAL same-name+country
  // sibling (one with keywords or leads). SearchConsole always sets keywords, and
  // a genuine post-wipe restore is the only session with its name — so this only
  // ever deletes true phantoms. delete() un-assigns leads first, so no data loss.
  const leadCountByProject = new Map<number, number>()
  for (const l of allLeads) {
    if (l.projectId !== undefined) {
      leadCountByProject.set(l.projectId, (leadCountByProject.get(l.projectId) ?? 0) + 1)
    }
  }
  let phantomsRemoved = 0
  for (const p of localProjects) {
    if (!p.id) continue
    const isEmpty = (p.keywords?.length ?? 0) === 0 && (p.cities?.length ?? 0) === 0
    if (!isEmpty || (leadCountByProject.get(p.id) ?? 0) > 0) continue
    const hasRealSibling = localProjects.some((q) =>
      q.id && q.id !== p.id &&
      nameCountryKey(q.name, q.country) === nameCountryKey(p.name, p.country) &&
      ((q.keywords?.length ?? 0) > 0 || (leadCountByProject.get(q.id) ?? 0) > 0)
    )
    if (hasRealSibling) {
      await searchProjectRepository.delete(p.id).catch(() => {})
      phantomsRemoved++
    }
  }
  if (phantomsRemoved > 0) {
    await log('sync', `Removed ${phantomsRemoved} phantom duplicate session${phantomsRemoved > 1 ? 's' : ''}`)
  }

  // Track mssqlId → IndexedDB leadId so we can link research results below
  const mssqlToLocalId = new Map<string, number>()

  // Local statuses that are AHEAD of MSSQL (the best-effort validation sync
  // missed them, e.g. API was down during validation) get pushed back up to
  // MSSQL after the loop instead of being silently downgraded locally.
  const statusBackfill: Array<{ mssqlId: string; status: 'selected' | 'not_relevant' }> = []

  let updated = 0, inserted = 0
  for (const c of data.companies) {
    // Map MSSQL statuses back to the extension's LeadStatus
    const vs = (c.validationStatus ?? '').toLowerCase()
    const es = (c.enrichmentStatus ?? '').toLowerCase()
    let status: Lead['status'] = 'new'
    if (vs === 'selected' || vs === 'relevant')          status = 'selected'
    else if (vs === 'rejected' || vs === 'not_relevant') status = 'rejected'
    else if (es === 'enriched' || es === 'completed')    status = 'research_completed'

    const normName = (c.companyName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)
    const nameCity = `${normName}|${(c.city ?? '').toLowerCase()}`

    // Check if this lead already exists locally (by mssqlId first, then name+city)
    const existing = byMssqlId.get(c.companyId) ?? byNameCity.get(nameCity)

    const restoredTags: string[] | undefined =
      c.tagsJson ? (() => { try { return JSON.parse(c.tagsJson) } catch { return undefined } })() : undefined

    if (existing?.id) {
      // UPDATE in place — preserve IndexedDB id so all linked records stay valid.
      //
      // Status merge is rank-guarded, never a blind overwrite: the validation
      // status only reaches MSSQL best-effort, so a lead the user/AI already
      // SELECTED locally can look like plain 'new' in MSSQL. The old code took
      // MSSQL's word unconditionally and silently demoted selected leads back
      // to 'new' on every dashboard open. Now the HIGHER-ranked status wins,
      // and when local is ahead we backfill MSSQL instead.
      //
      // Repair: a lead validated relevant but sitting at 'new' was demoted by
      // an earlier destructive sync — treat it as 'selected' again.
      const effectiveLocal: Lead['status'] =
        existing.status === 'new' && existing.validationStatus === 'relevant' ? 'selected' : existing.status
      const localRank  = STATUS_RANK[effectiveLocal] ?? 0
      const remoteRank = STATUS_RANK[status] ?? 0

      if (remoteRank >= localRank) {
        await leadRepository.updateStatus(existing.id, status)
      } else {
        if (effectiveLocal !== existing.status) {
          await leadRepository.updateStatus(existing.id, effectiveLocal)
        }
        if (effectiveLocal === 'selected' || effectiveLocal.startsWith('research_')) {
          statusBackfill.push({ mssqlId: c.companyId, status: 'selected' })
        } else if (effectiveLocal === 'rejected') {
          statusBackfill.push({ mssqlId: c.companyId, status: 'not_relevant' })
        }
      }
      const metaUpdate: Record<string, unknown> = {}
      if (!existing.mssqlId)        metaUpdate.mssqlId = c.companyId
      if (c.notes && !existing.notes)     metaUpdate.notes = c.notes
      if (restoredTags?.length && !existing.tags?.length) metaUpdate.tags = restoredTags
      if (c.validationReason && !existing.validationReason) metaUpdate.validationReason = c.validationReason
      if (existing.projectId === undefined && c.runId !== undefined && runToLocalProject.has(c.runId)) {
        metaUpdate.projectId = runToLocalProject.get(c.runId)
      }
      if (Object.keys(metaUpdate).length) await db.leads.update(existing.id, metaUpdate)
      mssqlToLocalId.set(c.companyId, existing.id)
      updated++
    } else {
      // INSERT: company exists in MSSQL but not locally (e.g. after reinstall)
      try {
        const leadId = await leadRepository.create({
          companyName:      c.companyName,
          normalizedName:   normName,
          address:          c.address,
          phone:            c.phone,
          website:          c.website,
          googleMapsUrl:    c.googleMapsUrl,
          rating:           c.rating,
          reviewCount:      c.reviewCount,
          category:         c.category,
          city:             c.city,
          keyword:          c.keyword ?? '',
          searchQuery:      c.sessionName ?? '',
          status,
          capturedAt:       c.sessionCreatedAt ?? nowISO(),
          updatedAt:        nowISO(),
          confidence:       0.8,
          sessionId:        0,
          projectId:        c.runId !== undefined ? runToLocalProject.get(c.runId) : undefined,
          source:           'sql_restore' as const,
          mssqlId:          c.companyId,
          notes:            c.notes,
          tags:             restoredTags,
          validationReason: c.validationReason,
        })
        mssqlToLocalId.set(c.companyId, leadId)
        inserted++
      } catch { /* skip on constraint violation */ }
    }
  }

  // Restore research results for leads that don't already have one locally.
  // This covers the "reinstall" case — MSSQL has the full AI result JSON saved earlier.
  const existingResults = await researchResultRepository.getAll()
  const leadsWithResult = new Set(existingResults.map(r => r.leadId))

  let resultsRestored = 0
  for (const e of data.enrichments ?? []) {
    const localLeadId = mssqlToLocalId.get(e.companyId)
    if (!localLeadId || leadsWithResult.has(localLeadId)) continue

    if (e.fullResultJson) {
      try {
        const full = JSON.parse(e.fullResultJson)
        // Strip the old IndexedDB id — let the DB assign a new one
        delete full.id
        full.leadId = localLeadId
        await researchResultRepository.create(full)
        resultsRestored++
        continue
      } catch { /* fall through to basic restore */ }
    }

    // Fallback: restore from individual columns (used when fullResultJson is absent — older records)
    const parseJsonField = (v: unknown): unknown[] | undefined => {
      if (!v) return undefined
      try { const p = JSON.parse(v as string); return Array.isArray(p) ? p : undefined } catch { return undefined }
    }
    try {
      await researchResultRepository.create({
        leadId:                localLeadId,
        jobId:                 0,
        email:                 e.email                ?? undefined,
        website:               e.website               ?? undefined,
        alternatePhone:        e.alternatePhone        ?? undefined,
        whatsapp:              e.whatsapp              ?? undefined,
        linkedIn:              e.linkedIn              ?? undefined,
        facebook:              e.facebook              ?? undefined,
        instagram:             e.instagram             ?? undefined,
        youtube:               e.youtube               ?? undefined,
        twitter:               e.twitter               ?? undefined,
        decisionMaker:         e.decisionMaker         ?? undefined,
        decisionMakerLinkedIn: e.decisionMakerLinkedIn ?? undefined,
        industry:              e.industry              ?? undefined,
        tagline:               e.tagline               ?? undefined,
        summary:               e.summary               ?? undefined,
        supplierBuyerType:     e.supplierBuyerType     ?? undefined,
        employeeCount:         e.employeeCount         ?? undefined,
        yearFounded:           e.yearFounded ? parseInt(e.yearFounded) : undefined,
        companyType:           e.companyType           ?? undefined,
        annualTurnover:        e.annualTurnover        ?? undefined,
        headquarters:          e.headquarters          ?? undefined,
        confidence:            e.confidence            ?? 0.5,
        createdAt:             e.enrichedAt            ?? nowISO(),
        teamMembers:           parseJsonField(e.teamMembersJson),
        certifications:        parseJsonField(e.certificationsJson),
        majorClients:          parseJsonField(e.majorClientsJson),
        expansionSignals:      parseJsonField(e.expansionSignalsJson),
        currentSoftware:       parseJsonField(e.currentSoftwareJson),
        exportMarkets:         parseJsonField(e.exportMarketsJson),
        painPoints:            parseJsonField(e.painPointsJson),
        services:              parseJsonField(e.servicesJson),
      } as any)
      resultsRestored++
    } catch { /* skip */ }
  }

  // Restore DeepResearch records (GAP D1 fix) — data is in MSSQL but was never synced back to IDB.
  let deepRestoredCount = 0
  if (data.deepResearch?.length) {
    const existingDR = await db.deepResearch.toArray()
    const leadsWithDR = new Set(existingDR.map(dr => dr.leadId))
    for (const dr of data.deepResearch) {
      const localLeadId = mssqlToLocalId.get(dr.companyId)
      if (!localLeadId || leadsWithDR.has(localLeadId)) continue
      if (!dr.fullDeepResearchJson) continue
      try {
        const full = JSON.parse(dr.fullDeepResearchJson)
        delete full.id
        full.leadId = localLeadId
        await db.deepResearch.add(full)
        deepRestoredCount++
      } catch { /* skip malformed JSON */ }
    }
  }

  // Push locally-ahead statuses up to MSSQL so both sides converge without
  // ever losing a selection. Best-effort — retried on the next sync if it fails.
  if (statusBackfill.length > 0) {
    saveValidationBulkToSql(statusBackfill).catch(() => {})
  }

  await log('system', `MSSQL sync: ${dedupedCount} duplicates removed, ${updated} updated, ${inserted} new leads, ${statusBackfill.length} local statuses kept & pushed to MSSQL, ${projectsRestored} sessions restored, ${resultsRestored} research results restored, ${deepRestoredCount} deep research restored`)
  return { synced: updated + inserted }
}

async function handleCaptureFinished(payload: CaptureFinishedPayload) {
  const session = activeSession
  if (!session) return
  // An orphaned capture (its SW instance died mid-run and a new term was started
  // by the queue watchdog) finishing late must not complete the CURRENT session
  // and double-advance the queue — only accept the finish for the session we track.
  if (payload.sessionId && payload.sessionId !== session.sessionId) return
  // Null activeSession immediately — any LEAD_FOUND messages still in the event queue
  // will see null and exit early, preventing double-writes after capture ends.
  // We captured the session reference above so we can still use it below.
  activeSession = null

  const { reason } = payload
  const fewerThanMax = session.totalCaptured < session.maxResults
  const countNote = fewerThanMax
    ? `Google Maps only had ${session.totalCaptured} results (requested ${session.maxResults})`
    : `${session.totalCaptured} leads captured`

  const statusMsg =
    reason === 'max_reached'  ? `Max ${session.maxResults} results reached` :
    reason === 'end_of_list'  ? `End of list — ${countNote}` :
    reason === 'no_new_leads' ? `No new leads found — ${countNote}` :
    reason === 'scroll_limit' ? `Scroll limit reached — ${countNote}` :
    reason === 'stopped'      ? `Stopped by user — ${session.totalCaptured} captured` :
    reason === 'error'        ? `Capture error — ${session.totalCaptured} captured` :
    `Capture ended — ${session.totalCaptured} captured`

  await searchSessionRepository.complete(session.sessionId, session.totalCaptured)
  await log('search_completed', `${statusMsg}. Captured: ${session.totalCaptured}`, session.sessionId)

  broadcastProgress({
    sessionId:         session.sessionId,
    totalCaptured:     session.totalCaptured,
    duplicatesSkipped: session.duplicatesSkipped,
    status:            reason === 'stopped' ? 'stopped' : 'completed',
    message:           statusMsg,
  })

  // Sync session to MSSQL — fire and forget
  syncSessionToSql(session.sessionId, session.city, session.keyword, session.totalCaptured).catch(() => {})

  // Advance the batch campaign if one is running. We pass session.mapsTabId explicitly
  // because activeSession is already null at this point — advanceBatchCampaign needs
  // the tab ID to close the finished Maps tab before opening the next city's tab.
  if (activeBatchCampaignId !== null) {
    advanceBatchCampaign(session.totalCaptured, session.mapsTabId).catch(() => {})
  } else {
    // Advance the persisted Search Console queue if one is running; when there
    // is no queue this behaves as a plain single search (focus dashboard + run
    // the auto-pipeline). During a multi-term run the pipeline and dashboard
    // focus deliberately wait until the LAST term — refocusing the dashboard
    // between terms fought with the next Maps tab for focus, and validation/
    // research opening extra Google tabs mid-run worsened rate limiting.
    advanceSearchQueue(session.totalCaptured).catch((err) => {
      console.error('[search-queue] advance failed:', err)
      log('search_queue', `⚠️ Failed to start next queued search: ${err?.message ?? 'unknown error'} — the watchdog will retry within 2 minutes`).catch(() => {})
    })
  }
}

async function handleBackgroundDiscover(keyword: string, city: string, autoResearch: boolean) {
  await log('discovery_started', `Background discovery: "${keyword}" in ${city}`)

  const { leads, sources } = await discoverLeads(keyword, city)
  if (!leads.length) {
    await log('discovery_completed', `No leads found for "${keyword}" in ${city}`)
    return { found: 0, saved: 0, sources }
  }

  const settings = autoResearch ? await loadSettingsForResearch() : null
  const hasKey = settings
    ? (settings.researchProvider === 'gemini' ? !!settings.geminiApiKey
        : settings.researchProvider === 'openai' ? !!settings.openAiApiKey
        : !!settings.anthropicApiKey)
    : false

  let saved = 0
  for (const discovered of leads) {
    try {
      const candidates = await leadRepository.findCandidatesForDedupe(
        0, normalizeName(discovered.companyName), discovered.phone, undefined
      )
      if (isDuplicate({
        companyName:    discovered.companyName,
        normalizedName: normalizeName(discovered.companyName),
        city,
        keyword,
        searchQuery:    `${keyword} in ${city}`,
        phone:          discovered.phone,
        address:        discovered.address,
        website:        discovered.website,
        category:       discovered.category ?? keyword,
        status:         'new',
        capturedAt:     nowISO(),
        updatedAt:      nowISO(),
        confidence:     0.7,
        sessionId:      0,
        source:         discovered.source,
      }, candidates)) continue

      const id = await leadRepository.create({
        companyName:   discovered.companyName,
        phone:         discovered.phone,
        address:       discovered.address,
        website:       discovered.website,
        category:      discovered.category ?? keyword,
        city:          discovered.city,
        keyword,
        searchQuery:   `${keyword} in ${city}`,
        normalizedName: normalizeName(discovered.companyName),
        status:        'new',
        capturedAt:    nowISO(),
        updatedAt:     nowISO(),
        confidence:    0.7,
        sessionId:     0,
        source:        discovered.source,
      })
      saved++

      if (autoResearch && hasKey) {
        const savedLead = await leadRepository.getById(id)
        if (savedLead) await addToResearchQueue(savedLead).catch(() => {})
      }
    } catch { /* skip individual failures */ }
  }

  await log('discovery_completed',
    `Background discovery found ${leads.length}, saved ${saved} new leads from ${sources.join(', ')}`)

  return { found: leads.length, saved, sources }
}

async function syncSessionToSql(sessionId: number, city: string, keyword: string, totalCaptured: number) {
  const available = await isApiAvailable()
  if (!available) return  // Local API not running — skip silently

  const leads = await leadRepository.getByFilter({ sessionId })
  const allResults = await researchResultRepository.getAll()
  const sessionResultLeadIds = new Set(leads.map((l) => l.id!))
  const researchResults = allResults.filter((r) => sessionResultLeadIds.has(r.leadId))

  const result = await syncToSql(
    { city, keyword, totalCaptured },
    leads.map((l) => ({
      id: l.id!,
      companyName: l.companyName,
      address: l.address,
      phone: l.phone,
      website: l.website,
      googleMapsUrl: l.googleMapsUrl,
      rating: l.rating,
      reviewCount: l.reviewCount,
      category: l.category,
      city: l.city,
    })),
    researchResults.map((r) => ({
      leadId:        r.leadId,
      decisionMaker: r.decisionMaker,
      email:         r.email,
      website:       r.website,
      linkedIn:      r.linkedIn,
      facebook:      r.facebook,
      instagram:     r.instagram,
      youtube:       r.youtube,
      summary:       r.summary,
      services:      r.services,
      employeeCount: r.employeeCount,
      yearFounded:   r.yearFounded,
      companyType:   r.companyType,
      confidence:    r.confidence,
      fullResultJson: JSON.stringify(r),  // GAP B1 fix: UpsertEnrichment now writes this
    })),
  )

  // Write MSSQL UUIDs back to IndexedDB so OutreachPanel can load conversation history
  if (result.ok && result.leadIdMap) {
    for (const [indexedDbId, mssqlId] of Object.entries(result.leadIdMap)) {
      const numId = parseInt(indexedDbId, 10)
      if (!isNaN(numId) && mssqlId) {
        await leadRepository.updateMany([numId], { mssqlId })
      }
    }
  }

  await activityLogRepository.log(
    result.ok ? 'sql_sync_completed' : 'sql_sync_failed',
    result.ok
      ? `Synced ${result.synced} leads to MSSQL deeplead database`
      : `MSSQL sync failed: ${result.error}`,
    sessionId
  )
}

// ─── Search Console queue ─────────────────────────────────────────────────────
// The multi-term (keyword×city) run is owned by the service worker and persisted
// to chrome.storage.local. Previously the queue lived in the dashboard's React
// state — refreshing or closing the dashboard tab silently killed a run that was
// hours from finishing. Now the dashboard only submits the term list and renders
// progress; the SW survives dashboard death, and the persisted state survives SW
// restarts and even full browser restarts (resumed by the alarm watchdog below).

interface SearchQueueState {
  terms: Array<{ keyword: string; city: string }>
  country: string
  index: number        // current term (0-based)
  totalLeads: number   // cumulative captured across finished terms
  settings: SearchStartPayload['settings']
  updatedAt: number    // epoch ms of last progress — stall detection
  projectId?: number   // Search Session this run belongs to
}

const SEARCH_QUEUE_KEY = 'searchQueue'

async function getSearchQueue(): Promise<SearchQueueState | null> {
  const data = await chrome.storage.local.get(SEARCH_QUEUE_KEY)
  return (data[SEARCH_QUEUE_KEY] as SearchQueueState) ?? null
}

async function setSearchQueue(state: SearchQueueState): Promise<void> {
  await chrome.storage.local.set({ [SEARCH_QUEUE_KEY]: state })
}

async function clearSearchQueue(): Promise<void> {
  await chrome.storage.local.remove(SEARCH_QUEUE_KEY)
}

function queueProgressOf(q: SearchQueueState): SearchQueueProgress {
  const term = q.terms[q.index]
  return {
    current: Math.min(q.index + 1, q.terms.length),
    total: q.terms.length,
    keyword: term?.keyword ?? '',
    city: term?.city ?? '',
    totalLeads: q.totalLeads,
  }
}

async function handleSearchQueueStart(payload: SearchQueueStartPayload, senderTabId?: number) {
  dashboardTabId = senderTabId ?? dashboardTabId
  if (!payload.terms?.length) throw new Error('Search queue is empty')

  const queue: SearchQueueState = {
    terms: payload.terms,
    country: payload.country,
    index: 0,
    totalLeads: 0,
    settings: payload.settings,
    updatedAt: Date.now(),
    projectId: payload.projectId,
  }
  await setSearchQueue(queue)
  await log('search_queue', `Search run started — ${queue.terms.length} searches queued`)
  await startQueueTerm(queue)
}

// Creates the session record for the queue's current term and starts its capture.
async function startQueueTerm(queue: SearchQueueState) {
  const term = queue.terms[queue.index]
  const generatedQuery = `${term.keyword} in ${term.city}`
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(generatedQuery)}`

  const sessionId = await searchSessionRepository.create({
    city: term.city, keyword: term.keyword,
    generatedQuery, mapsUrl,
    status: 'idle', maxResults: BATCH_UNLIMITED,
    totalCaptured: 0, duplicatesSkipped: 0,
  })

  broadcastProgress({
    sessionId,
    totalCaptured: 0,
    duplicatesSkipped: 0,
    status: 'opening_maps',
    message: `Search ${queue.index + 1}/${queue.terms.length}: ${generatedQuery}`,
    queue: queueProgressOf(queue),
  })

  await handleSearchStart({
    sessionId,
    city: term.city,
    keyword: term.keyword,
    country: queue.country,
    mapsUrl,
    maxResults: BATCH_UNLIMITED,
    settings: queue.settings,
    projectId: queue.projectId,
  })
}

// Called from handleCaptureFinished for every non-batch capture. When no queue
// is persisted this is a plain single search — keep the original behavior.
async function advanceSearchQueue(captured: number) {
  const queue = await getSearchQueue()
  if (!queue) {
    focusDashboardTab().catch(() => {})
    maybeRunAutoPipeline().catch(() => {})
    return
  }

  queue.totalLeads += captured
  queue.index++
  queue.updatedAt = Date.now()

  // Keep the Search Session card's progress live (terms done + leads so far).
  if (queue.projectId !== undefined) {
    await searchProjectRepository.recordTermCompleted(queue.projectId, captured).catch(() => {})
  }

  if (queue.index >= queue.terms.length) {
    await clearSearchQueue()
    if (queue.projectId !== undefined) {
      await searchProjectRepository.setStatus(queue.projectId, 'completed').catch(() => {})
      const project = await searchProjectRepository.getById(queue.projectId).catch(() => undefined)
      if (project?.mssqlRunId !== undefined) {
        updateSearchRunInSql(project.mssqlRunId, { status: 'completed', totalLeads: project.totalLeads }).catch(() => {})
      }
    }
    await log('search_queue', `Search run completed — ${queue.terms.length} searches, ${queue.totalLeads} total leads`)
    broadcastProgress({
      sessionId: 0,
      totalCaptured: queue.totalLeads,
      duplicatesSkipped: 0,
      status: 'completed',
      message: `All ${queue.terms.length} searches complete — ${queue.totalLeads} total leads`,
      queue: { ...queueProgressOf(queue), done: true },
    })
    focusDashboardTab().catch(() => {})
    maybeRunAutoPipeline().catch(() => {})
    return
  }

  await setSearchQueue(queue)

  // Randomized 8–15s pause between searches — advancing at bot speed makes
  // Google Maps serve rate-limit pages after a few dozen terms, and every
  // capture after that silently ends with 0 leads.
  await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 7000)))

  // Re-read — the user may have hit Stop (queue cleared) during the pause.
  const still = await getSearchQueue()
  if (!still || still.index !== queue.index) return
  await startQueueTerm(still)
}

// MV3 kills idle service workers. If that happens during the between-terms
// pause — or a capture dies without ever delivering CAPTURE_FINISHED — the
// persisted queue would sit stalled forever. The 1-minute research alarm
// doubles as a watchdog: queue present + no active capture + no progress for
// 2+ minutes ⇒ restart the current term. Re-running a term is safe because
// capture dedup skips already-saved leads. This is also what resumes a run
// after a full browser restart.
const QUEUE_STALL_MS = 2 * 60 * 1000

async function resumeStalledSearchQueue() {
  if (activeSession) return
  const queue = await getSearchQueue()
  if (!queue) return
  if (Date.now() - queue.updatedAt < QUEUE_STALL_MS) return

  queue.updatedAt = Date.now()
  await setSearchQueue(queue)
  const term = queue.terms[queue.index]
  await log('search_queue', `Resuming stalled search run at ${queue.index + 1}/${queue.terms.length} (${term.keyword} in ${term.city})`)
  await startQueueTerm(queue)
}

// ─── Batch campaign ───────────────────────────────────────────────────────────

// Called by handleCaptureFinished after each city completes.
// completedMapsTabId is passed explicitly because activeSession is already null
// by the time this runs — we must not rely on it to close the finished tab.
// Batch campaigns always capture everything Maps returns — the auto-scroller
// stops on its own when no new results load.
const BATCH_UNLIMITED = 9999

async function advanceBatchCampaign(cityCaptured: number, completedMapsTabId: number) {
  if (activeBatchCampaignId === null) return
  const campaign = await getCampaign(activeBatchCampaignId)
  // Campaign was deleted externally or IndexedDB is corrupt — clear the in-memory flag.
  if (!campaign) { activeBatchCampaignId = null; return }

  const idx = campaign.currentCityIndex
  // Work on a copy so we can set multiple city statuses atomically in one updateCampaign call.
  const cities = [...campaign.cities]
  cities[idx] = { ...cities[idx], status: 'completed', capturedCount: cityCaptured, completedAt: nowISO() }

  const nextIdx = idx + 1
  const totalCaptured = campaign.totalCaptured + cityCaptured

  // Keep the campaign's Search Session card in step with city completions.
  if (campaign.projectId !== undefined) {
    await searchProjectRepository.recordTermCompleted(campaign.projectId, cityCaptured).catch(() => {})
  }

  if (nextIdx >= cities.length) {
    // All cities finished — mark campaign complete and clear in-memory state.
    await updateCampaign(campaign.id!, {
      cities, status: 'completed', totalCaptured, completedAt: nowISO(),
    })
    activeBatchCampaignId = null
    if (campaign.projectId !== undefined) {
      await searchProjectRepository.setStatus(campaign.projectId, 'completed').catch(() => {})
      const project = await searchProjectRepository.getById(campaign.projectId).catch(() => undefined)
      if (project?.mssqlRunId !== undefined) {
        updateSearchRunInSql(project.mssqlRunId, { status: 'completed', totalLeads: project.totalLeads }).catch(() => {})
      }
    }
    await log('batch_campaign', `Campaign "${campaign.keyword}" completed — ${totalCaptured} total leads`)
    chrome.tabs.remove(completedMapsTabId).catch(() => {})
    focusDashboardTab().catch(() => {})
    maybeRunAutoPipeline().catch(() => {})
    return
  }

  // More cities remain — mark the next city as running and persist before opening the tab
  // so BatchCampaignPanel polling sees the updated state immediately.
  cities[nextIdx] = { ...cities[nextIdx], status: 'running', startedAt: nowISO() }
  await updateCampaign(campaign.id!, {
    cities, currentCityIndex: nextIdx, totalCaptured,
  })

  await log('batch_campaign', `Campaign "${campaign.keyword}" — moving to city ${nextIdx + 1}/${cities.length}: ${cities[nextIdx].city}`)

  // Wait 3 seconds between cities to avoid triggering Maps rate limiting.
  await new Promise((r) => setTimeout(r, 3000))

  // Close the Maps tab from the completed city. activeSession is null here so we
  // use the ID that was passed in from handleCaptureFinished before it nulled the session.
  chrome.tabs.remove(completedMapsTabId).catch(() => {})

  // Create a fresh session record for this city and kick off capture via the normal flow.
  const nextCity = cities[nextIdx].city
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(campaign.keyword + ' in ' + nextCity)}`
  const nextSessionId = await searchSessionRepository.create({
    city: nextCity, keyword: campaign.keyword,
    generatedQuery: `${campaign.keyword} in ${nextCity}`,
    mapsUrl,
    status: 'idle', maxResults: BATCH_UNLIMITED,
    totalCaptured: 0, duplicatesSkipped: 0,
  })

  // Reuse cachedSettings loaded at campaign start — avoids a DB read per city.
  await handleSearchStart({
    sessionId:  nextSessionId,
    city:       nextCity,
    keyword:    campaign.keyword,
    country:    cities[nextIdx].country ?? campaign.country ?? cachedSettings?.lastCountry ?? 'IN',
    mapsUrl,
    maxResults: BATCH_UNLIMITED,
    settings:   cachedSettings ?? DEFAULT_SETTINGS,
    projectId:  campaign.projectId,
  })
}

// Triggered by BATCH_CAMPAIGN_START from BatchCampaignPanel after it has already
// created the campaign record in IndexedDB. We only receive the ID to keep the
// message payload small and to ensure persistence survives a service worker restart.
async function handleBatchCampaignStart(payload: { campaignId: number }) {
  const campaign = await getCampaign(payload.campaignId)
  // Guard: reject if the campaign was deleted or is already running/completed
  // (e.g. user double-clicked Start).
  if (!campaign || campaign.status !== 'pending') return { ok: false, reason: 'invalid_campaign' }

  activeBatchCampaignId = campaign.id!

  // Load and cache settings once for the whole campaign. advanceBatchCampaign reuses
  // this cache so subsequent cities don't each hit IndexedDB.
  cachedSettings = await loadSettingsForResearch()

  // A batch campaign is a Search Session too — one card, its leads tagged, its
  // own business profile snapshot for validation/research.
  const campaignCountry = campaign.country ?? cachedSettings?.lastCountry ?? 'IN'
  const projectId = await searchProjectRepository.create({
    name: `${campaign.keyword} — ${campaignCountry} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    country: campaignCountry,
    keywords: [campaign.keyword],
    cities: campaign.cities.map((c) => c.city),
    businessProfile: cachedSettings?.businessProfile ?? '',
    status: 'running',
    totalTerms: campaign.cities.length,
    completedTerms: 0,
    totalLeads: 0,
    source: 'batch_campaign',
  })

  // Mark first city as running and update IndexedDB before opening any tabs
  // so the UI immediately reflects the correct state on its next 3s poll.
  const cities = campaign.cities.map((c, i) => ({
    ...c,
    status: i === 0 ? ('running' as const) : c.status,
    startedAt: i === 0 ? nowISO() : c.startedAt,
  }))
  await updateCampaign(campaign.id!, { status: 'running', cities, currentCityIndex: 0, projectId })

  const firstCity = cities[0].city
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(campaign.keyword + ' in ' + firstCity)}`
  const firstSessionId = await searchSessionRepository.create({
    city: firstCity, keyword: campaign.keyword,
    generatedQuery: `${campaign.keyword} in ${firstCity}`,
    mapsUrl,
    status: 'idle', maxResults: BATCH_UNLIMITED,
    totalCaptured: 0, duplicatesSkipped: 0,
  })

  await handleSearchStart({
    sessionId:  firstSessionId,
    city:       firstCity,
    keyword:    campaign.keyword,
    country:    cities[0].country ?? campaignCountry,
    mapsUrl,
    maxResults: BATCH_UNLIMITED,
    settings:   cachedSettings,
    projectId,
  })

  await log('batch_campaign', `Campaign "${campaign.keyword}" started — ${cities.length} cities`)
  return { ok: true }
}

// Stop is two-step: mark the campaign record stopped in IndexedDB first,
// then stop the current city's capture (which closes the Maps tab and
// sends MAPS_STOP_CAPTURE to the content script).
async function handleBatchCampaignStop() {
  if (activeBatchCampaignId !== null) {
    const campaign = await getCampaign(activeBatchCampaignId)
    if (campaign) {
      await updateCampaign(campaign.id!, { status: 'stopped', completedAt: nowISO() })
      if (campaign.projectId !== undefined) {
        await searchProjectRepository.setStatus(campaign.projectId, 'stopped').catch(() => {})
      }
      await log('batch_campaign', `Campaign "${campaign.keyword}" stopped by user`)
    }
    // Clear the flag before calling handleCaptureStop so CAPTURE_FINISHED
    // (which may arrive shortly after) doesn't try to advance the campaign.
    activeBatchCampaignId = null
  }
  await handleCaptureStop()
}

async function handleCaptureStop() {
  // Stop cancels the whole run: clear any queued Search Console terms BEFORE
  // stopping the current capture, so neither the advance path nor the alarm
  // watchdog can start the next term afterwards. Must run even when no capture
  // is active — Stop can arrive during the between-terms pause.
  const queue = await getSearchQueue()
  if (queue) {
    await clearSearchQueue()
    if (queue.projectId !== undefined) {
      await searchProjectRepository.setStatus(queue.projectId, 'stopped').catch(() => {})
      const project = await searchProjectRepository.getById(queue.projectId).catch(() => undefined)
      if (project?.mssqlRunId !== undefined) {
        updateSearchRunInSql(project.mssqlRunId, { status: 'stopped', totalLeads: project.totalLeads }).catch(() => {})
      }
    }
    await log('search_queue', `Search run stopped at ${queue.index + 1}/${queue.terms.length} — ${queue.totalLeads} leads captured across finished searches`)
  }

  const session = activeSession
  if (!session) return
  activeSession = null

  chrome.tabs.sendMessage(session.mapsTabId, { type: MSG.MAPS_STOP_CAPTURE }).catch(() => {})
  await log('capture_stopped', 'Capture stopped by user', session.sessionId)

  await searchSessionRepository.updateStatus(session.sessionId, 'stopped', { completedAt: nowISO() })

  broadcastProgress({
    sessionId:         session.sessionId,
    totalCaptured:     session.totalCaptured,
    duplicatesSkipped: session.duplicatesSkipped,
    status:            'stopped',
    message:           'Capture stopped',
  })
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg.type as string

  if (type === MSG.SEARCH_START) {
    handleSearchStart(msg.payload as SearchStartPayload, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[SEARCH_START] failed:', err)
        sendResponse({ ok: false, error: err?.message })
      })
    return true
  }

  if (type === MSG.SEARCH_QUEUE_START) {
    handleSearchQueueStart(msg.payload as SearchQueueStartPayload, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[SEARCH_QUEUE_START] failed:', err)
        sendResponse({ ok: false, error: err?.message })
      })
    return true
  }

  if (type === MSG.LEAD_FOUND) {
    // If this throws partway through (dedup check, save, MSSQL trigger), the
    // lead would otherwise vanish silently with zero visibility — log it so a
    // long capture session never drops leads without a trace.
    handleLeadFound(msg.payload as LeadFoundPayload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        const companyName = (msg.payload as LeadFoundPayload)?.lead?.companyName ?? 'unknown'
        console.error(`[LEAD_FOUND] failed to process "${companyName}":`, err)
        log('system', `⚠️ Failed to save captured lead "${companyName}": ${err?.message ?? 'unknown error'}`).catch(() => {})
        sendResponse({ ok: false, error: err?.message })
      })
    return true
  }

  if (type === MSG.CAPTURE_FINISHED) {
    handleCaptureFinished(msg.payload as CaptureFinishedPayload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[CAPTURE_FINISHED] failed:', err)
        sendResponse({ ok: false, error: err?.message })
      })
    return true
  }

  if (type === MSG.CAPTURE_STOP) {
    handleCaptureStop()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[CAPTURE_STOP] failed:', err)
        sendResponse({ ok: false, error: err?.message })
      })
    return true
  }

  if (type === MSG.GET_STATUS) {
    // Include the persisted multi-term queue so a freshly (re)opened dashboard
    // can restore "Term X of Y" progress for a run the SW is still driving.
    getSearchQueue()
      .then((q) => sendResponse({ activeSession, searchQueue: q ? queueProgressOf(q) : null }))
      .catch(() => sendResponse({ activeSession, searchQueue: null }))
    return true
  }

  if (type === MSG.OPEN_DASHBOARD) {
    openDashboard()
    sendResponse({ ok: true })
    return true
  }

  if (type === MSG.CONTENT_READY) {
    sendResponse({ ok: true })
    return true
  }

  if (type === MSG.SYNC_FROM_DB) {
    syncLeadsFromMssql()
      .then((result) => sendResponse({ ok: true, synced: result.synced }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (type === MSG.BACKGROUND_DISCOVER) {
    const { keyword, city, autoResearch } = msg.payload as { keyword: string; city: string; autoResearch?: boolean }
    handleBackgroundDiscover(keyword, city, autoResearch ?? false)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.TRIGGER_RESEARCH) {
    loadSettingsForResearch().then((settings) => {
      const hasKey = settings.researchProvider === 'gemini' ? !!settings.geminiApiKey
        : settings.researchProvider === 'openai' ? !!settings.openAiApiKey
        : !!settings.anthropicApiKey
      if (!hasKey) {
        sendResponse({ ok: false, reason: 'no_api_key', provider: settings.researchProvider })
        return
      }
      tickResearchQueue()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message }))
    }).catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.PIPELINE_RUN) {
    const { projectId, force } = (msg.payload ?? {}) as { projectId?: number; force?: boolean }
    chrome.storage.local.set({ pipeline_stop: false })
      .then(() => runPipeline(projectId, force))
      .catch(() => {})
    sendResponse({ ok: true })
    return true
  }

  if (type === MSG.PIPELINE_STOP) {
    chrome.storage.local.set({ pipeline_stop: true })
      .then(() => setPipelineState({ status: 'stopped' }))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.VERIFY_FROM_GOOGLE) {
    const { projectId } = (msg.payload ?? {}) as { projectId?: number }
    chrome.storage.local.set({ pipeline_stop: false })
      .then(() => runVerifyFromGoogle(projectId))
      .catch(() => {})
    sendResponse({ ok: true })
    return true
  }

  if (type === MSG.BATCH_CAMPAIGN_START) {
    handleBatchCampaignStart(msg.payload)
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (type === MSG.BATCH_CAMPAIGN_STOP) {
    handleBatchCampaignStop()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.BATCH_CAMPAIGN_STATUS) {
    sendResponse({ activeBatchCampaignId })
    return true
  }

  if (type === MSG.CHECK_FOLLOWUPS) {
    checkNurtureSequences()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  // ── LinkedIn automated scraper ──────────────────────────────────────────────

  if (type === MSG.LI_SCRAPER_START) {
    const { leadId, companyName, linkedInUrl, mssqlId } = msg.payload as {
      leadId: number; companyName: string; linkedInUrl: string; mssqlId?: string
    }
    // Guard against clobbering an in-progress scrape — there is only one
    // li_scraper_job storage slot. Without this check, a manual "Start" click
    // while the auto-queue (tickLinkedInQueue) is mid-scrape for a different
    // lead would silently overwrite that job's tracking, orphaning its tab.
    getLiJob().then(async (activeJob) => {
      if (activeJob && activeJob.status === 'running') {
        sendResponse({ ok: false, error: `A LinkedIn scrape is already running for "${activeJob.companyName}" — wait for it to finish.` })
        return
      }
      try {
        const job = await startLiScraperJob(leadId, companyName, linkedInUrl, mssqlId)
        // Open a dedicated tab to the company posts page
        const tab = await chrome.tabs.create({ url: stepUrl(job), active: true })
        job.tabId = tab.id ?? null
        // Persist updated tabId
        await chrome.storage.local.set({ li_scraper_job: job })
        sendResponse({ ok: true, jobId: job.id })
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message })
      }
    }).catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.LI_SCRAPER_READY) {
    // Content script on a LinkedIn page is ready — check if it's our scraper tab
    const { url } = msg as { type: string; url: string }
    const senderTabId = sender.tab?.id
    getLiJob().then((job) => {
      if (!job || job.status !== 'running') { sendResponse({ cmd: 'ignore' }); return }
      if (senderTabId !== job.tabId)        { sendResponse({ cmd: 'ignore' }); return }
      if (!urlMatchesStep(url, job))        { sendResponse({ cmd: 'ignore' }); return }
      sendResponse({ cmd: 'scrape', step: job.step, companyName: job.companyName })
    }).catch(() => sendResponse({ cmd: 'ignore' }))
    return true
  }

  if (type === MSG.LI_SCRAPER_DATA) {
    const { step, data } = msg as { type: string; step: string; data: any }
    ingestStepData(step as any, data)
      .then(async ({ nextUrl, job }) => {
        if (nextUrl && job.tabId) {
          // Navigate the same tab to the next page. Can reject with "Tabs cannot
          // be edited right now (user may be dragging a tab)" — a transient OS-level
          // condition, not a real failure; swallow it rather than leave an unhandled
          // rejection (it surfaced as a spurious extension error).
          chrome.tabs.update(job.tabId, { url: nextUrl }).catch(() => {})
        } else if (!nextUrl) {
          // Scraping is complete — save results to IndexedDB and MSSQL
          await saveLiJobToDeepResearch(job)
          await saveLiJobToLinkedInSql(job)
          chrome.tabs.sendMessage(job.tabId ?? -1, { type: 'LI_DONE' }).catch(() => {})
          // Close the scraper tab from the SW side — content-script window.close()
          // is blocked after multi-page navigation, and an unattended queue run
          // must not leave tabs piling up.
          const tabToClose = job.tabId
          if (tabToClose) {
            setTimeout(() => { chrome.tabs.remove(tabToClose).catch(() => {}) }, 3000)
          }
        }
        sendResponse({ ok: true })
      })
      .catch((err) => sendResponse({ ok: false, error: err?.message }))
    return true
  }

  if (type === MSG.LI_SCRAPER_CANCEL) {
    cancelLiJob().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
    return true
  }

  if (type === MSG.LI_SCRAPER_STATUS) {
    getLiJob().then((job) => sendResponse({ ok: true, job })).catch(() => sendResponse({ ok: false, job: null }))
    return true
  }

  // Forward live progress updates from content script to dashboard
  if (type === MSG.CAPTURE_PROGRESS && activeSession) {
    const p = msg.payload as CaptureProgressPayload
    broadcastProgress({
      sessionId: p.sessionId,
      totalCaptured: activeSession.totalCaptured,
      duplicatesSkipped: activeSession.duplicatesSkipped,
      status: p.status,
      message: p.message,
    })
    sendResponse({ ok: true })
    return true
  }
})

// ─── Tab removal cleanup ──────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === lastMapsTabId) lastMapsTabId = null
  if (activeSession && tabId === activeSession.mapsTabId) {
    await log('capture_stopped', 'Maps tab closed — capture ended', activeSession.sessionId)
    await searchSessionRepository.updateStatus(activeSession.sessionId, 'stopped', { completedAt: nowISO() })
    activeSession = null
  }
  if (tabId === dashboardTabId) {
    dashboardTabId = null
  }
  // If user closes the LinkedIn scraper tab, mark the job cancelled
  getLiJob().then((job) => {
    if (job && job.tabId === tabId && job.status === 'running') {
      cancelLiJob().catch(() => {})
    }
  }).catch(() => {})
})

// ─── Nurture sequence checker ─────────────────────────────────────────────────

const NURTURE_ALARM = 'nurture-check'

// Runs hourly via Chrome alarm. If Interakt is configured it auto-sends due sequences
// and marks them as sent. Without Interakt it just logs the count so the user can
// manually send from NurturePanel. Errors are swallowed at both levels — the outer
// try/catch handles a missing local API, the inner one skips individual send failures
// so one bad phone number doesn't block the rest of the batch.
async function checkNurtureSequences() {
  try {
    const due = await getDueSequences()
    if (!due.length) return

    const settings = await loadSettingsForResearch()
    // If Interakt is not set up, surface the count in logs and exit.
    // The user will see due sequences in NurturePanel → Scheduled tab.
    if (!settings.interaktApiKey) {
      await log('nurture', `${due.length} nurture sequence(s) due — configure Interakt to auto-send`)
      return
    }

    for (const seq of due) {
      try {
        // Hard block — never auto-send to someone on the Existing Clients list.
        const blocked = await existingClientRepository.findMatch(seq.phone, seq.companyName, seq.city)
        if (blocked) {
          await log('nurture', `Skipped ${seq.companyName} — already in touch (Existing Clients match)`)
          continue
        }

        // Replace our custom {{variable}} placeholders with actual contact values.
        // The rendered string becomes bodyValues[2] in the Interakt payload — the
        // actual positional variables {{1}} {{2}} etc. are defined in the approved template.
        const body = seq.messageTemplate
          .replace(/\{\{contact_name\}\}/g, seq.contactName ?? '')
          .replace(/\{\{company_name\}\}/g, seq.companyName ?? '')
          .replace(/\{\{city\}\}/g, seq.city ?? '')

        const res = await fetch('https://api.interakt.ai/v1/public/message/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${settings.interaktApiKey}`,
          },
          body: JSON.stringify({
            countryCode: settings.interaktCountryCode ?? '+91',
            phoneNumber: seq.phone,
            callbackData: `nurture:${seq.id}`,
            type: 'Template',
            template: {
              name: settings.interaktTemplateName || seq.templateName,
              languageCode: 'en',
              bodyValues: [seq.contactName, seq.companyName, body],
            },
          }),
        })

        if (res.ok) {
          await markSequenceSent(seq.id)
          await log('nurture', `Nurture sent to ${seq.companyName} (${seq.channel})`)
        }
      } catch { /* skip this sequence — bad phone number or Interakt error, try next */ }
    }
  } catch { /* local API not running — sequences will be picked up on the next hourly tick */ }
}

// ─── Research queue processor ─────────────────────────────────────────────────

const RESEARCH_ALARM = 'research-queue-poll'

// Loads settings from IndexedDB, then falls back to the local API's appsettings.json
// for AI keys. This two-level lookup allows the developer to set keys in appsettings.json
// without having to enter them in the extension UI — useful during development and testing.
async function loadSettingsForResearch(): Promise<AppSettings> {
  let settings = DEFAULT_SETTINGS
  try {
    const record = await db.settings.get('app_settings')
    if (record?.value) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(record.value) }
  } catch {}

  // A blank saved profile (pre-existing installs, before the ICP prompt was
  // hardcoded) should not shadow the hardcoded default.
  if (!settings.businessProfile?.trim()) settings = { ...settings, businessProfile: DEFAULT_SETTINGS.businessProfile }

  // If the extension UI has no API key, try pulling one from appsettings.json via the
  // local API. This is the fallback for the "developer machine" scenario where the key
  // lives in the backend config and has not been entered in the extension settings page.
  const needsKey = settings.researchProvider === 'gemini' ? !settings.geminiApiKey
    : settings.researchProvider === 'openai' ? !settings.openAiApiKey
    : !settings.anthropicApiKey

  if (needsKey) {
    try {
      const apiConfig = await fetchApiConfig()
      if (apiConfig?.hasKey) {
        settings = apiConfig.researchProvider === 'gemini'
          ? { ...settings, researchProvider: 'gemini', geminiApiKey: apiConfig.geminiApiKey, geminiModel: apiConfig.geminiModel }
          : { ...settings, researchProvider: 'openai', openAiApiKey: apiConfig.openAiApiKey, openAiModel: apiConfig.openAiModel }
      }
    } catch {}
  }

  return settings
}

// Starts the next queued LinkedIn deep-scrape (6-month company posts + core
// team activity) when no scrape is currently running. Research jobs enqueue
// companies here whenever they discover a LinkedIn company URL.
async function tickLinkedInQueue(): Promise<boolean> {
  const activeJob = await getLiJob()
  if (activeJob && activeJob.status === 'running') {
    // Stale-job guard — a scrape stuck > 15 min (closed tab, SW restart) is
    // cancelled so it can't block the research + LinkedIn queues forever.
    const ageMs = Date.now() - new Date(activeJob.startedAt).getTime()
    if (ageMs > 15 * 60 * 1000) {
      console.warn(`[li-queue] ⚠️ Scrape of "${activeJob.companyName}" stuck for ${Math.round(ageMs / 60000)} min — cancelling`)
      await cancelLiJob()
    } else {
      return true   // one at a time
    }
  }

  const next = await dequeueLiScrape()
  if (!next) return false

  console.log(`[li-queue] ▶️ Starting LinkedIn deep-scrape: "${next.companyName}" (${next.linkedInUrl})`)
  const job = await startLiScraperJob(next.leadId, next.companyName, next.linkedInUrl, next.mssqlId)
  const tab = await chrome.tabs.create({ url: stepUrl(job), active: true })
  job.tabId = tab.id ?? null
  await chrome.storage.local.set({ li_scraper_job: job })
  return true
}

// Re-entrancy lock for tickResearchQueue. This function can be triggered from
// two independent sources — the 1-minute alarm AND the Dashboard's "Run Now"
// button (TRIGGER_RESEARCH message) — with no relationship between them. Without
// this lock, two overlapping calls could both read "no LinkedIn job queued /
// running" before either finishes writing, letting a new research job (lead 2's
// Google search) start in the same window as the previous lead's LinkedIn
// deep-scrape tab opens — the exact interleaving the LI-queue priority check
// is meant to prevent. The lock makes "check LinkedIn queue → maybe start research
// job" one atomic step regardless of how many callers overlap.
let tickInFlight = false

// Drains the research job queue one job at a time. The while loop keeps going until
// the queue is empty so a burst of new leads (e.g. after a large capture) doesn't
// have to wait for the next 1-minute alarm tick to continue processing.
async function tickResearchQueue() {
  if (tickInFlight) return
  tickInFlight = true
  try {
    // Never run research (which opens real browser tabs to Google/websites/social
    // sites) while a Maps scrape — single search or batch campaign — is in
    // progress. The two compete for tab focus and look exactly like bot behavior
    // when interleaved. Research resumes automatically once scraping finishes.
    if (activeSession !== null || activeBatchCampaignId !== null) return

    // LinkedIn deep-scrapes take priority over the next research job — the RPA
    // drives a visible tab, and interleaving it with research visits would look
    // like bot behavior. Research resumes once the LinkedIn queue is empty.
    const liBusy = await tickLinkedInQueue().catch(() => false)
    if (liBusy) return

    const settings = await loadSettingsForResearch()
    const hasKey = settings.researchProvider === 'gemini' ? !!settings.geminiApiKey
      : settings.researchProvider === 'openai' ? !!settings.openAiApiKey
      : !!settings.anthropicApiKey
    if (!hasKey) return

    const config = {
      researchProvider: settings.researchProvider,
      anthropicApiKey:  settings.anthropicApiKey,
      anthropicModel:   settings.anthropicModel,
      openAiApiKey:     settings.openAiApiKey,
      openAiModel:      settings.openAiModel,
      geminiApiKey:     settings.geminiApiKey,
      geminiModel:      settings.geminiModel,
      businessProfile:  settings.businessProfile,
    }

    // Process exactly ONE lead per tick — never a whole queue back-to-back. The
    // 1-minute alarm naturally paces this to one person researched per minute,
    // which is the human-like cadence requested (one lead, one person, at a time).
    await processNextJob(config)
  } finally {
    tickInFlight = false
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // tickResearchQueue's try/finally resets its lock on any error, but the error
  // itself still propagates — .catch() here prevents it becoming an unhandled
  // promise rejection on every alarm tick if something unexpected throws.
  if (alarm.name === RESEARCH_ALARM) {
    // Close any scraper tabs orphaned by a killed service worker BEFORE opening
    // new ones — stops research tabs from piling up into tab-access/forbidden
    // errors on long multi-city/keyword runs.
    sweepOrphanScraperTabs().catch(() => {})
    tickResearchQueue().catch((err) => console.error('[research-alarm] tick failed:', err))
    // Watchdog for the persisted Search Console queue — resumes a run that
    // stalled because the SW was killed mid-pause or a capture died silently.
    resumeStalledSearchQueue().catch((err) => console.error('[search-queue] resume failed:', err))
  }
  if (alarm.name === NURTURE_ALARM)   checkNurtureSequences()
  // Keepalive: firing this alarm resets the worker's idle timer so a long
  // pipeline run isn't killed mid-way when the dashboard tab loses focus.
  if (alarm.name === PIPELINE_KEEPALIVE) { /* no-op — presence keeps the worker warm */ }
})

async function ensureResearchAlarm() {
  const existing = await chrome.alarms.get(RESEARCH_ALARM)
  if (!existing) chrome.alarms.create(RESEARCH_ALARM, { periodInMinutes: 1 })
}

async function ensureNurtureAlarm() {
  const existing = await chrome.alarms.get(NURTURE_ALARM)
  if (!existing) chrome.alarms.create(NURTURE_ALARM, { periodInMinutes: 60 })
}

// Chrome MV3 service workers are terminated aggressively. Any job that was mid-flight
// when the worker was killed will be stuck in 'running' forever unless we reset it here.
async function resetStuckJobs() {
  const stuck = await db.researchJobs.where('status').equals('running').toArray()
  for (const job of stuck) {
    if (job.id) await db.researchJobs.update(job.id, { status: 'pending' })
  }
}

// ─── LinkedIn scraper → DeepResearch ─────────────────────────────────────────

async function saveLiJobToDeepResearch(job: LinkedInScraperJob): Promise<void> {
  try {
    // Convert scraped LinkedIn data to the DeepResearch format
    const peopleActivity: PersonActivity[] = job.personResults.map(r => ({
      name:          r.person.name,
      role:          r.person.title,
      linkedInUrl:   r.person.profileUrl,
      posts:         r.posts.map(p => ({
        platform:  'linkedin' as const,
        date:      p.relativeDate,
        headline:  p.content.slice(0, 120),
        snippet:   p.content.slice(0, 500),
        url:       p.postUrl || undefined,
      } as SocialPost)),
      topics:        [],
      activitySummary: `${r.posts.filter(p => p.withinMonth).length} of ${r.posts.length} posts in last 30 days`,
    }))

    const companySignals: string[] = job.companyPosts
      .filter(p => p.withinMonth)
      .map(p => p.content.slice(0, 400))

    // Find existing researchResult for this lead (for the FK)
    const existing = await researchResultRepository.getAll()
    const researchResultId = existing.find(r => r.leadId === job.leadId)?.id ?? 0

    // Check if a DeepResearch record already exists for this lead → update it
    const existingDR = await db.deepResearch.where('leadId').equals(job.leadId).first()
    const drRecord: DeepResearch = {
      researchResultId,
      leadId:         job.leadId,
      peopleActivity,
      companySignals,
      intentSignals:  [],
      recommendedPitch: '',
      researchedAt:   new Date().toISOString(),
    }

    if (existingDR?.id) {
      await db.deepResearch.update(existingDR.id, drRecord)
    } else {
      await db.deepResearch.add(drRecord)
    }

    // Mark lead as research_completed if not already
    const lead = await leadRepository.getById(job.leadId)
    if (lead && lead.status === 'selected') {
      await leadRepository.updateStatus(job.leadId, 'research_completed')
    }

    // Save full data to MSSQL
    const { saveDeepResearchToSql } = await import('@/services/sqlSyncService')
    if (lead) {
      // Pack into the DeepResearch shape saveDeepResearchToSql expects
      await saveDeepResearchToSql(lead, {
        ...drRecord,
        id: existingDR?.id,
        fullDeepResearchJson: JSON.stringify({ ...drRecord, rawLinkedInJob: job }),
      } as any).catch(() => {})
    }

    await log('system', `LinkedIn scrape saved: ${job.companyName} — ${job.companyPosts.length} company posts, ${job.personResults.length} people profiled`)
  } catch (err: any) {
    await log('system', `LinkedIn scrape save error: ${err?.message}`)
  }
}

// ─── LinkedIn scraper → dedicated MSSQL tables (Phase 3 LinkedIn Business Intelligence) ──

async function saveLiJobToLinkedInSql(job: LinkedInScraperJob): Promise<void> {
  try {
    const lead = await leadRepository.getById(job.leadId)
    if (!lead) return

    const {
      saveLinkedInCompanyProfile, saveLinkedInCompanyPosts,
      saveLinkedInPeople, saveLinkedInPersonPosts,
    } = await import('@/services/sqlSyncService')

    if (job.companyProfile) {
      await saveLinkedInCompanyProfile(lead, job.companyProfile).catch(() => {})
    }
    if (job.companyPosts.length > 0) {
      await saveLinkedInCompanyPosts(lead, job.companyPosts).catch(() => {})
    }
    if (job.teamMembers.length > 0) {
      await saveLinkedInPeople(lead, job.teamMembers).catch(() => {})
    }
    for (const result of job.personResults) {
      await saveLinkedInPersonPosts(lead, result.person, result.posts).catch(() => {})
    }

    await log('system', `LinkedIn intelligence synced to SQL: ${job.companyName}`)
  } catch (err: any) {
    await log('system', `LinkedIn intelligence SQL sync error: ${err?.message}`)
  }
}

// ─── Extension install / update ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await log('system', `LeadScout AI extension ${details.reason}`)
  await ensureResearchAlarm()
  await ensureNurtureAlarm()
  await resetStuckJobs()

  // On fresh install, sync from MSSQL — it is the single source of truth.
  // If MSSQL is empty, extension stays empty.
  if (details.reason === 'install') {
    syncLeadsFromMssql().catch(() => {})
  }
})

async function restoreLeadsFromSql() {
  const available = await isApiAvailable()
  if (!available) return  // API not running — nothing to restore

  const data = await restoreFromSql()
  if (!data || !data.companies?.length) return

  // Map companyId (SQL GUID) → IndexedDB lead id for enrichment linking
  const idMap = new Map<string, number>()

  // Build a lookup of existing leads to avoid re-inserting duplicates
  const existingLeads = await leadRepository.getAll()
  const existingNames = new Set(existingLeads.map((l) => l.companyName?.toLowerCase()))

  let restored = 0
  for (const c of data.companies) {
    if (existingNames.has(c.companyName?.toLowerCase())) continue

    const leadId = await leadRepository.create({
      companyName:   c.companyName,
      address:       c.address,
      phone:         c.phone,
      website:       c.website,
      googleMapsUrl: c.googleMapsUrl,
      rating:        c.rating,
      reviewCount:   c.reviewCount,
      category:      c.category,
      city:          c.city,
      keyword:       c.keyword ?? '',
      searchQuery:   c.sessionName ?? '',
      normalizedName: c.companyName?.toLowerCase() ?? '',
      status:        'new',
      capturedAt:    c.sessionCreatedAt ?? nowISO(),
      updatedAt:     nowISO(),
      confidence:    0.8,
      sessionId:     0,
      source:        'sql_restore',
    })
    idMap.set(c.companyId, leadId)
    restored++
  }

  // Restore research results
  let enriched = 0
  for (const e of data.enrichments ?? []) {
    const leadId = idMap.get(e.companyId)
    if (!leadId) continue
    try {
      const services = e.services ? JSON.parse(e.services) : undefined
      await researchResultRepository.create({
        leadId,
        jobId:         0,
        decisionMaker: e.decisionMaker ?? undefined,
        email:         e.email ?? undefined,
        website:       e.website ?? undefined,
        linkedIn:      e.linkedIn ?? undefined,
        facebook:      e.facebook ?? undefined,
        instagram:     e.instagram ?? undefined,
        youtube:       e.youtube ?? undefined,
        services,
        employeeCount: e.employeeCount ?? undefined,
        yearFounded:   e.yearFounded ? Number(e.yearFounded) : undefined,
        companyType:   e.companyType ?? undefined,
        summary:       e.summary ?? undefined,
        confidence:    e.confidence ?? 0.5,
      })
      enriched++
    } catch { /* skip duplicates */ }
  }

  await log('sql_restore_completed', `Restored ${restored} leads and ${enriched} research results from MSSQL`)
}

chrome.runtime.onStartup.addListener(async () => {
  await ensureResearchAlarm()
  await ensureNurtureAlarm()
  await resetStuckJobs()
})

// Also ensure alarms exist every time the service worker wakes (covers dev reloads)
ensureResearchAlarm()
ensureNurtureAlarm()
resetStuckJobs()
sweepOrphanScraperTabs().catch(() => {})   // close any tabs a previously-killed worker left open
