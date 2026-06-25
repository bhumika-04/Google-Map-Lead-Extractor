import { MSG } from '@/types/messages'
import type {
  SearchStartPayload,
  LeadFoundPayload,
  CaptureProgressPayload,
  CaptureFinishedPayload,
  ProgressUpdatePayload,
} from '@/types/messages'
import type { Lead } from '@/types/lead'
import { searchSessionRepository } from '@/db/searchSessionRepository'
import { leadRepository } from '@/db/leadRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { isDuplicate, mergeLeadData } from '@/utils/dedupe'
import { normalizeName } from '@/utils/normalize'
import { nowISO } from '@/utils/date'
import { openDashboard } from '@/services/chromeMessaging'
import { processNextJob } from '@/services/researchService'
import { addToResearchQueue } from '@/services/futureResearchService'
import { discoverLeads } from '@/services/directoryDiscovery'
import { syncToSql, isApiAvailable, fetchApiConfig, restoreFromSql, saveLeadBatchToSql } from '@/services/sqlSyncService'
import { researchResultRepository } from '@/db/researchResultRepository'
import { db } from '@/db/db'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_SETTINGS } from '@/types/settings'

// ─── Session state (ephemeral, in memory) ─────────────────────────────────────

interface ActiveSession {
  sessionId: number
  mapsTabId: number
  city: string
  keyword: string
  searchQuery: string
  maxResults: number
  totalCaptured: number
  duplicatesSkipped: number
  status: string
}

let activeSession: ActiveSession | null = null
let dashboardTabId: number | null = null
let cachedSettings: AppSettings | null = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

function broadcastProgress(payload: ProgressUpdatePayload) {
  if (dashboardTabId !== null) {
    chrome.tabs.sendMessage(dashboardTabId, { type: MSG.PROGRESS_UPDATE, payload }).catch(() => {})
  }
  updateBadge(payload.totalCaptured, payload.status)
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

  // Open Maps tab
  const tab = await chrome.tabs.create({ url: payload.mapsUrl, active: true })
  const mapsTabId = tab.id!

  await log('maps_tab_opened', `Maps tab opened: ${payload.mapsUrl}`, payload.sessionId)

  activeSession = {
    sessionId: payload.sessionId,
    mapsTabId,
    city: payload.city,
    keyword: payload.keyword,
    searchQuery: `${payload.keyword} in ${payload.city}`,
    maxResults: payload.maxResults,
    totalCaptured: 0,
    duplicatesSkipped: 0,
    status: 'running',
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
  // Snapshot session immediately — prevents race condition when CAPTURE_FINISHED
  // nulls activeSession while async DB writes are still in flight
  const session = activeSession
  if (!session) return

  const lead = payload.lead as Omit<Lead, 'id'>

  lead.city        = lead.city        || session.city
  lead.keyword     = lead.keyword     || session.keyword
  lead.searchQuery = lead.searchQuery || session.searchQuery
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

    // Save to MSSQL every 10 leads — direct DB write, not just a backup
    if (session.totalCaptured % 10 === 0) {
      const recentLeads = await leadRepository.getByFilter({ sessionId: session.sessionId })
      saveLeadBatchToSql(session.city, session.keyword, recentLeads.map((l) => ({
        id: l.id!, companyName: l.companyName, address: l.address, phone: l.phone,
        website: l.website, googleMapsUrl: l.googleMapsUrl, rating: l.rating,
        reviewCount: l.reviewCount, category: l.category, city: l.city,
      }))).catch(() => {})
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
// Clears all local lead data first, then repopulates from MSSQL.
// If MSSQL is empty the extension stays empty — no stale data can survive.

async function syncLeadsFromMssql(): Promise<{ synced: number }> {
  const available = await isApiAvailable()
  if (!available) return { synced: 0 }

  // Always clear local lead tables first
  await db.transaction('rw', [db.leads, db.searchSessions], async () => {
    await db.leads.clear()
    await db.searchSessions.clear()
  })

  const data = await restoreFromSql()
  if (!data?.companies?.length) {
    await log('system', 'MSSQL sync: database empty — local cache cleared')
    return { synced: 0 }
  }

  // Build a lookup of existing leads (shouldn't be any after clear, but be safe)
  let synced = 0
  for (const c of data.companies) {
    try {
      // Map MSSQL validation_status and enrichment_status back to LeadStatus
      const vs = (c.validationStatus ?? '').toLowerCase()
      const es = (c.enrichmentStatus ?? '').toLowerCase()
      let status: Lead['status'] = 'new'
      if (vs === 'selected')         status = 'selected'
      else if (vs === 'rejected')    status = 'rejected'
      else if (es === 'enriched')    status = 'research_completed'

      await leadRepository.create({
        companyName:    c.companyName,
        normalizedName: (c.companyName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80),
        address:        c.address,
        phone:          c.phone,
        website:        c.website,
        googleMapsUrl:  c.googleMapsUrl,
        rating:         c.rating,
        reviewCount:    c.reviewCount,
        category:       c.category,
        city:           c.city,
        keyword:        c.keyword ?? '',
        searchQuery:    c.sessionName ?? '',
        status,
        capturedAt:     c.sessionCreatedAt ?? nowISO(),
        updatedAt:      nowISO(),
        confidence:     0.8,
        sessionId:      0,
        source:         'sql_restore' as const,
      })
      synced++
    } catch { /* skip on constraint violation */ }
  }

  await log('system', `MSSQL sync: ${synced} leads loaded from database`)
  return { synced }
}

async function handleCaptureFinished(payload: CaptureFinishedPayload) {
  const session = activeSession
  if (!session) return
  activeSession = null  // null early so no more LEAD_FOUND writes race against us

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
      leadId: r.leadId,
      decisionMaker: r.decisionMaker,
      email: r.email,
      website: r.website,
      linkedIn: r.linkedIn,
      facebook: r.facebook,
      instagram: r.instagram,
      youtube: r.youtube,
      summary: r.summary,
      services: r.services,
      employeeCount: r.employeeCount,
      yearFounded: r.yearFounded,
      companyType: r.companyType,
      confidence: r.confidence,
    })),
  )

  await activityLogRepository.log(
    result.ok ? 'sql_sync_completed' : 'sql_sync_failed',
    result.ok
      ? `Synced ${result.synced} leads to MSSQL deeplead database`
      : `MSSQL sync failed: ${result.error}`,
    sessionId
  )
}

async function handleCaptureStop() {
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
    handleSearchStart(msg.payload as SearchStartPayload, sender.tab?.id).then(() => sendResponse({ ok: true }))
    return true
  }

  if (type === MSG.LEAD_FOUND) {
    handleLeadFound(msg.payload as LeadFoundPayload).then(() => sendResponse({ ok: true }))
    return true
  }

  if (type === MSG.CAPTURE_FINISHED) {
    handleCaptureFinished(msg.payload as CaptureFinishedPayload).then(() => sendResponse({ ok: true }))
    return true
  }

  if (type === MSG.CAPTURE_STOP) {
    handleCaptureStop().then(() => sendResponse({ ok: true }))
    return true
  }

  if (type === MSG.GET_STATUS) {
    sendResponse({ activeSession })
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
      tickResearchQueue().then(() => sendResponse({ ok: true }))
    })
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
  if (activeSession && tabId === activeSession.mapsTabId) {
    await log('capture_stopped', 'Maps tab closed — capture ended', activeSession.sessionId)
    await searchSessionRepository.updateStatus(activeSession.sessionId, 'stopped', { completedAt: nowISO() })
    activeSession = null
  }
  if (tabId === dashboardTabId) {
    dashboardTabId = null
  }
})

// ─── Research queue processor ─────────────────────────────────────────────────

const RESEARCH_ALARM = 'research-queue-poll'

async function loadSettingsForResearch(): Promise<AppSettings> {
  let settings = DEFAULT_SETTINGS
  try {
    const record = await db.settings.get('app_settings')
    if (record?.value) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(record.value) }
  } catch {}

  // If no key in extension settings, pull from local DeepLead API (stored in appsettings.json)
  const needsKey = settings.researchProvider === 'gemini' ? !settings.geminiApiKey
    : settings.researchProvider === 'openai' ? !settings.openAiApiKey
    : !settings.anthropicApiKey

  if (needsKey) {
    try {
      const apiConfig = await fetchApiConfig()
      if (apiConfig?.hasKey) {
        settings = {
          ...settings,
          researchProvider: apiConfig.researchProvider,
          openAiApiKey: apiConfig.openAiApiKey,
          openAiModel: apiConfig.openAiModel,
        }
      }
    } catch {}
  }

  return settings
}

async function tickResearchQueue() {
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
  }

  // Process all pending jobs sequentially — keep going until the queue is empty
  let processed = true
  while (processed) {
    processed = await processNextJob(config)
    if (processed) {
      // Brief pause between jobs to avoid rate limit bursts
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESEARCH_ALARM) tickResearchQueue()
})

async function ensureResearchAlarm() {
  const existing = await chrome.alarms.get(RESEARCH_ALARM)
  if (!existing) chrome.alarms.create(RESEARCH_ALARM, { periodInMinutes: 1 })
}

async function resetStuckJobs() {
  // Jobs left in 'running' state when the service worker was killed — reset to pending
  const stuck = await db.researchJobs.where('status').equals('running').toArray()
  for (const job of stuck) {
    if (job.id) await db.researchJobs.update(job.id, { status: 'pending' })
  }
}

// ─── Extension install / update ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await log('system', `LeadScout AI extension ${details.reason}`)
  await ensureResearchAlarm()
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
  await resetStuckJobs()
})

// Also ensure alarm exists every time the service worker wakes (covers dev reloads)
ensureResearchAlarm()
resetStuckJobs()
