// Fully automated pipeline — triggered by service worker after Maps scraping ends.
// Runs without any user interaction:
//   1. Gemini enrichment (grounding, ~1.5s/lead)
//   2. ICP batch validation (10 leads/call)
//   3. Queue ALL relevant leads for research
//   4. Auto-start the research queue
// User only needs to enter country, city, keyword and click Start once.

import { db } from '@/db/db'
import { leadRepository } from '@/db/leadRepository'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { validateLeads, DailyQuotaExhaustedError } from './leadValidationService'
import { saveValidationBulkToSql, saveIcpBulkToSql, resolveAiCredentials } from './sqlSyncService'
import { addToResearchQueue } from './futureResearchService'
import { runPreValidationEnrichment } from './preValidationEnrichmentService'
import { MSG } from '@/types/messages'
import { toast } from '@/state/useToastStore'
import type { AppSettings } from '@/types/settings'

// Re-run (force): drop enrichment records + reset status so the whole scope is
// reprocessed from scratch. Scoped to a project when given.
async function resetScopeForRerun(projectId?: number): Promise<void> {
  let leads = await leadRepository.getAll()
  if (projectId !== undefined) leads = leads.filter((l) => (l.projectId ?? -1) === projectId)
  const ids = leads.map((l) => l.id!).filter((x): x is number => !!x)
  if (!ids.length) return
  await db.researchResults.where('leadId').anyOf(ids).and((r) => r.jobId === 0).delete().catch(() => {})
  await leadRepository.updateMany(ids, { status: 'new' })
}

type ValidationResult = Awaited<ReturnType<typeof validateLeads>>[number]

// Persist one batch of validation results immediately, so the workspace funnel
// (Scored / Relevant) climbs live during a long validation run instead of
// jumping only at the very end.
async function persistValidationBatch(batch: ValidationResult[]): Promise<void> {
  if (!batch.length) return
  const rel = batch.filter((r) => r.relevant)
  const notRel = batch.filter((r) => !r.relevant)
  await leadRepository.bulkUpdateValidation([
    ...rel.map((r)    => ({ id: r.leadId, status: 'relevant'     as const, reason: r.reason })),
    ...notRel.map((r) => ({ id: r.leadId, status: 'not_relevant' as const, reason: r.reason })),
  ])
  await leadRepository.updateMany(rel.map((r) => r.leadId), { status: 'selected' })
  await leadRepository.bulkUpdateIcpFields(batch.map((r) => ({
    id: r.leadId, icpScore: r.icpScore, icpStatus: r.icpStatus,
    icpReason: r.reason, icpScoreBreakdown: r.scoreBreakdown,
  })))
}

export async function runAutoValidationAndResearch(
  settings: AppSettings,
  opts?: {
    onPhaseChange?: (phase: string) => void
    onProgress?: (done: number, total: number) => void
    shouldStop?: () => boolean | Promise<boolean>
    projectId?: number   // scope to one session (undefined = all sessions)
    force?: boolean      // re-run: reprocess every lead in scope, not just 'new'
  },
): Promise<void> {
  const onPhaseChange = opts?.onPhaseChange
  const onProgress = opts?.onProgress
  const shouldStop = opts?.shouldStop ?? (async () => false)
  const projectId = opts?.projectId
  const force = opts?.force ?? false

  const { provider, apiKey } = await resolveAiCredentials(settings)
  if (!apiKey.trim()) {
    const msg = `Auto-pipeline skipped — add a ${provider} API key to DeepLeadApi/appsettings.json and restart the backend`
    toast.warning(msg)
    activityLogRepository.log('auto_pipeline_skipped', msg).catch(() => {})
    return
  }

  if (force) await resetScopeForRerun(projectId)

  let scoped = await leadRepository.getAll()
  if (projectId !== undefined) scoped = scoped.filter((l) => (l.projectId ?? -1) === projectId)
  const newLeads = scoped.filter((l) => l.status === 'new')
  if (newLeads.length === 0) return
  if (await shouldStop()) return

  console.log(`[auto-pipeline] 🚀 Starting — ${newLeads.length} new leads`)

  // ── Step 1: enrichment (writes fields live per lead) ──────────────────────
  onPhaseChange?.('quick_enrichment_running')
  toast.info(`Step 1/3 — Enriching ${newLeads.length} leads…`)
  console.log(`[auto-pipeline] Step 1: enrichment`)
  try {
    await runPreValidationEnrichment(newLeads, settings, apiKey, onProgress, shouldStop)
  } catch (err) {
    console.warn('[auto-pipeline] Enrichment error (non-fatal):', err)
  }

  if (await shouldStop()) return

  // ── Step 2: ICP batch validation ──────────────────────────────────────────
  onPhaseChange?.('validation_running')
  const freshLeads = await leadRepository.getAll().then(all => all.filter(l => newLeads.some(n => n.id === l.id)))
  toast.info(`✓ Step 2/3 — Validating ${freshLeads.length} leads against ICP…`)
  console.log(`[auto-pipeline] Step 2: ICP validation`)

  const leadMap = new Map(freshLeads.map((l) => [l.id!, l]))
  let results: Awaited<ReturnType<typeof validateLeads>> = []

  // Validate per Search Session — each run's leads are scored against THAT
  // run's business profile (schools ICP vs pesticides ICP), falling back to
  // the global profile for unassigned leads or sessions without one.
  const groups = new Map<number, typeof freshLeads>()
  for (const l of freshLeads) {
    const key = l.projectId ?? -1
    const g = groups.get(key)
    if (g) g.push(l)
    else groups.set(key, [l])
  }

  const CHUNK = 20
  try {
    for (const [pid, groupLeads] of groups) {
      if (await shouldStop()) break
      const project = pid >= 0 ? await searchProjectRepository.getById(pid) : undefined
      const profile = (project?.businessProfile?.trim() || settings.businessProfile).trim()
      if (!profile) {
        const msg = `Validation skipped for ${groupLeads.length} leads — no business profile set (session or global)`
        toast.warning(msg)
        activityLogRepository.log('auto_pipeline_skipped', msg).catch(() => {})
        continue
      }
      if (project) console.log(`[auto-pipeline] Validating ${groupLeads.length} leads with "${project.name}" profile`)
      // Validate in chunks and persist each chunk immediately → Scored/Relevant climb live.
      for (let i = 0; i < groupLeads.length; i += CHUNK) {
        if (await shouldStop()) break
        const chunk = groupLeads.slice(i, i + CHUNK)
        const chunkResults = await validateLeads(chunk, profile, apiKey, provider, () => {})
        await persistValidationBatch(chunkResults)
        results = results.concat(chunkResults)
        onProgress?.(Math.min(i + CHUNK, groupLeads.length), groupLeads.length)
      }
    }
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) {
      toast.error('Auto-pipeline stopped — daily API quota exhausted')
    } else {
      toast.error('ICP validation failed — check console')
      console.error('[auto-pipeline] Validation error:', err)
    }
    if (results.length === 0) return
  }

  if (results.length === 0) return

  const relevant    = results.filter((r) => r.relevant)
  const notRelevant = results.filter((r) => !r.relevant)
  // (Validation + ICP scores were already persisted per chunk above.)

  // Sync to MSSQL
  const allTouched = await Promise.all(results.map((r) => leadRepository.getById(r.leadId)))
  const relevantIdSet = new Set(relevant.map(r => r.leadId))
  saveValidationBulkToSql(
    allTouched
      .filter((l): l is NonNullable<typeof l> => !!l?.mssqlId)
      .map((l) => ({ mssqlId: l.mssqlId!, status: relevantIdSet.has(l.id!) ? 'selected' as const : 'not_relevant' as const }))
  ).catch(() => {})
  saveIcpBulkToSql(
    allTouched
      .filter((l): l is NonNullable<typeof l> => !!l?.mssqlId && l.icpScore !== undefined)
      .map((l) => ({
        mssqlId: l.mssqlId!, icpScore: l.icpScore!, icpStatus: l.icpStatus ?? 'hold',
        icpReason: l.icpReason ?? '', icpScoreBreakdown: l.icpScoreBreakdown,
        teamSize: l.teamSize, annualTurnover: l.annualTurnover,
        industry: l.industry, companyType: l.companyType, decisionMaker: l.decisionMaker,
      }))
  ).catch(() => {})

  onPhaseChange?.('validation_completed')

  const highFit = results.filter(r => r.icpScore >= 80).length
  const goodFit = results.filter(r => r.icpScore >= 60 && r.icpScore < 80).length
  console.log(`[auto-pipeline] Validation done: ${relevant.length} relevant (${highFit} high-fit, ${goodFit} good), ${notRelevant.length} rejected`)

  if (relevant.length === 0) {
    toast.info(`Validation complete — no relevant leads found (${notRelevant.length} rejected)`)
    return
  }

  // ── Step 3: Queue ALL relevant leads for research, sorted by ICP score ────
  console.log(`[auto-pipeline] Step 3: queuing ${relevant.length} leads for research`)
  const sorted = [...relevant].sort((a, b) => b.icpScore - a.icpScore)
  const toQueue = settings.autoResearchTopN > 0 ? sorted.slice(0, settings.autoResearchTopN) : sorted

  let queued = 0
  for (const r of toQueue) {
    const lead = leadMap.get(r.leadId)
    if (!lead?.id) continue
    await addToResearchQueue(lead).catch(() => {})
    queued++
  }

  if (queued === 0) return

  onPhaseChange?.('research_queued')

  const summary = `Pipeline complete — ${relevant.length} qualified (${highFit} high-fit, ${goodFit} good), ${queued} queued for research. Starting automatically…`
  toast.success(summary)
  activityLogRepository.log('auto_pipeline_complete', summary).catch(() => {})
  console.log(`[auto-pipeline] 🏁 ${summary}`)

  // ── Step 4: Auto-start research queue — no user click needed ─────────────
  chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
}
