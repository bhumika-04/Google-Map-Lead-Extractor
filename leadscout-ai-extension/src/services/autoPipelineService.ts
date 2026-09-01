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
import { reconcileScrapedForLeads } from './scrapedReconcileService'
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

// Per-lead callback so the UI can show a live "why qualified / why rejected"
// feed while validation runs, instead of only a batch-level progress count.
type LeadResultCallback = (r: { name: string; relevant: boolean; icpScore: number; reason: string }) => void | Promise<void>

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
  // Advance BOTH outcomes off 'new' — only relevant leads were being moved
  // (to 'selected'), so a rejected lead's overarching status stayed 'new'
  // forever. Since the pipeline's own resume logic scopes to `status ===
  // 'new'`, every Continue click re-validated every previously-rejected
  // lead again from scratch, burning API calls on leads already scored.
  await leadRepository.updateMany(rel.map((r) => r.leadId), { status: 'selected' })
  await leadRepository.updateMany(notRel.map((r) => r.leadId), { status: 'rejected' })
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
    onLeadResult?: LeadResultCallback
  },
): Promise<void> {
  const onPhaseChange = opts?.onPhaseChange
  const onProgress = opts?.onProgress
  const shouldStop = opts?.shouldStop ?? (async () => false)
  const projectId = opts?.projectId
  const force = opts?.force ?? false
  const onLeadResult = opts?.onLeadResult

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
  console.log(`[auto-pipeline] Step 1: enrichment`)
  const onScopeResolved = (toEnrichCount: number, alreadyDoneCount: number) => {
    toast.info(
      alreadyDoneCount > 0
        ? `Step 1/3 — Enriching ${toEnrichCount} leads (${alreadyDoneCount} already done, resuming)…`
        : `Step 1/3 — Enriching ${toEnrichCount} leads…`
    )
  }
  // Mirror into scraped_leads periodically DURING the run, not just once at
  // the end — reconcileScrapedForLeads was only called after the whole loop
  // finished, so the workspace funnel's "Enriched" tile (which reads the
  // scraped_leads mirror) sat frozen for the entire run even though leads
  // were visibly being enriched one by one in the console/toasts.
  let lastReconciled = 0
  const enrichProgress = (done: number, total: number) => {
    onProgress?.(done, total)
    if (done - lastReconciled >= 20 || done === total) {
      lastReconciled = done
      reconcileScrapedForLeads(newLeads, 'enrichment').catch(() => {})
    }
  }
  try {
    await runPreValidationEnrichment(newLeads, settings, apiKey, enrichProgress, shouldStop, onScopeResolved)
  } catch (err) {
    console.warn('[auto-pipeline] Enrichment error (non-fatal):', err)
  }

  // Final mirror pass in case the last chunk was smaller than the throttle step.
  reconcileScrapedForLeads(newLeads, 'enrichment').catch(() => {})

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
        for (const r of chunkResults) {
          const name = chunk.find((c) => c.id === r.leadId)?.companyName ?? `lead ${r.leadId}`
          await onLeadResult?.({ name, relevant: r.relevant, icpScore: r.icpScore, reason: r.reason })
        }
        await persistValidationBatch(chunkResults)
        results = results.concat(chunkResults)
        onProgress?.(Math.min(i + CHUNK, groupLeads.length), groupLeads.length)
        // Mirror after every chunk, not just once at the end — otherwise the
        // funnel's Scored/Relevant tiles sit frozen for the whole run even
        // though the live feed and legacy table are updating per lead.
        reconcileScrapedForLeads(chunk, 'validation').catch(() => {})
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

  // Mirror validation/ICP into the new scraped_leads (local + new MSSQL).
  reconcileScrapedForLeads(freshLeads, 'validation').catch(() => {})

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

// Re-run a SINGLE pipeline step for a session, independent of the other steps —
// e.g. re-enrich without re-validating, or re-score against an edited ICP
// without re-running enrichment/research. `force` reprocesses every matching
// lead regardless of its current status; without it, only leads that haven't
// been through that step yet are touched.
export async function runPipelineStep(
  settings: AppSettings,
  opts: {
    step: 'enrichment' | 'validation' | 'research'
    projectId?: number
    force?: boolean
    onProgress?: (done: number, total: number) => void
    onLeadResult?: LeadResultCallback
    shouldStop?: () => boolean | Promise<boolean>
  },
): Promise<{ processed: number; message: string }> {
  const { step, projectId, force = false } = opts
  const onProgress = opts.onProgress
  const onLeadResult = opts.onLeadResult
  const shouldStop = opts.shouldStop ?? (async () => false)

  let scoped = await leadRepository.getAll()
  if (projectId !== undefined) scoped = scoped.filter((l) => (l.projectId ?? -1) === projectId)

  console.log(`[pipeline-step] 🚀 ${step} — projectId=${projectId ?? 'all'} force=${force} scope=${scoped.length} leads`)

  if (step === 'enrichment') {
    const targets = force
      ? scoped
      : scoped.filter((l) => !l.teamSize && !l.annualTurnover && !l.industry && !l.decisionMaker)
    if (targets.length === 0) {
      const msg = 'No leads need enrichment'
      console.log(`[pipeline-step] enrichment — ${msg}`)
      toast.info(msg)
      return { processed: 0, message: msg }
    }
    console.log(`[pipeline-step] enrichment — ${targets.length} targets`)
    toast.info(`Re-enriching ${targets.length} leads…`)
    // Mirror periodically DURING the run — otherwise the funnel's Enriched
    // tile sits frozen until the entire (potentially very long) run finishes.
    let lastReconciled = 0
    const enrichProgress = (done: number, total: number) => {
      onProgress?.(done, total)
      if (done - lastReconciled >= 20 || done === total) {
        lastReconciled = done
        reconcileScrapedForLeads(targets, 'enrichment').catch(() => {})
      }
    }
    try {
      await runPreValidationEnrichment(targets, settings, '', enrichProgress, shouldStop)
    } catch (err) {
      console.warn('[pipeline-step] Enrichment error (non-fatal):', err)
    }
    reconcileScrapedForLeads(targets, 'enrichment').catch(() => {})
    const msg = `Enrichment done — ${targets.length} leads processed`
    console.log(`[pipeline-step] ✅ ${msg}`)
    toast.success(msg)
    return { processed: targets.length, message: msg }
  }

  if (step === 'validation') {
    const { provider, apiKey } = await resolveAiCredentials(settings)
    if (!apiKey.trim()) {
      const msg = `Validation skipped — add a ${provider} API key to DeepLeadApi/appsettings.json and restart the backend`
      console.warn(`[pipeline-step] validation — ${msg}`)
      toast.warning(msg)
      return { processed: 0, message: msg }
    }
    const targets = force
      ? scoped.filter((l) => !l.status.startsWith('research'))
      : scoped.filter((l) => l.status === 'new')
    if (targets.length === 0) {
      const msg = 'No leads to validate'
      console.log(`[pipeline-step] validation — ${msg}`)
      toast.info(msg)
      return { processed: 0, message: msg }
    }
    const project = projectId !== undefined ? await searchProjectRepository.getById(projectId) : undefined
    const profile = (project?.businessProfile?.trim() || settings.businessProfile).trim()
    if (!profile) {
      const msg = 'Validation skipped — no business profile set (session or global)'
      console.warn(`[pipeline-step] validation — ${msg}`)
      toast.warning(msg)
      return { processed: 0, message: msg }
    }
    const usingSessionProfile = !!project?.businessProfile?.trim()
    console.log(`[pipeline-step] validation — ${targets.length} targets, provider=${provider}, source=${usingSessionProfile ? `session "${project!.name}"` : 'global (appsettings.json)'}, profile (${profile.length} chars): ${profile.slice(0, 300)}${profile.length > 300 ? '…' : ''}`)
    toast.info(`Re-validating ${targets.length} leads against the ICP…`)

    const CHUNK = 20
    let results: ValidationResult[] = []
    for (let i = 0; i < targets.length; i += CHUNK) {
      if (await shouldStop()) { console.log('[pipeline-step] validation — stop requested'); break }
      const chunk = targets.slice(i, i + CHUNK)
      console.log(`[pipeline-step] validation — batch ${Math.floor(i / CHUNK) + 1}: leads ${i + 1}-${Math.min(i + CHUNK, targets.length)} of ${targets.length}`)
      const chunkResults = await validateLeads(chunk, profile, apiKey, provider, () => {})
      const relevantInBatch = chunkResults.filter((r) => r.relevant).length
      for (const r of chunkResults) {
        const name = chunk.find((c) => c.id === r.leadId)?.companyName ?? `lead ${r.leadId}`
        console.log(`[pipeline-step]   ${r.relevant ? '✓' : '✕'} ${name} — score ${r.icpScore} — ${r.reason}`)
        await onLeadResult?.({ name, relevant: r.relevant, icpScore: r.icpScore, reason: r.reason })
      }
      console.log(`[pipeline-step] validation — batch done: ${chunkResults.length} scored, ${relevantInBatch} relevant`)
      await persistValidationBatch(chunkResults)
      results = results.concat(chunkResults)
      onProgress?.(Math.min(i + CHUNK, targets.length), targets.length)
      // Mirror after every chunk — otherwise the funnel's Scored/Relevant
      // tiles sit frozen until the entire run finishes.
      reconcileScrapedForLeads(chunk, 'validation').catch(() => {})
    }
    if (results.length === 0) return { processed: 0, message: 'Validation stopped before any results' }

    reconcileScrapedForLeads(targets, 'validation').catch(() => {})

    const allTouched = await Promise.all(results.map((r) => leadRepository.getById(r.leadId)))
    const relevantIdSet = new Set(results.filter((r) => r.relevant).map((r) => r.leadId))
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

    const relevantCount = results.filter((r) => r.relevant).length
    const msg = `Validation done — ${results.length} scored, ${relevantCount} relevant`
    console.log(`[pipeline-step] ✅ ${msg}`)
    toast.success(msg)
    return { processed: results.length, message: msg }
  }

  // step === 'research'
  const targets = force
    ? scoped.filter((l) => l.validationStatus === 'relevant' || l.status === 'selected' || l.status.startsWith('research'))
    : scoped.filter((l) => (l.validationStatus === 'relevant' || l.status === 'selected') && !l.status.startsWith('research'))
  if (targets.length === 0) {
    const msg = 'No relevant leads to queue for research'
    console.log(`[pipeline-step] research — ${msg}`)
    toast.info(msg)
    return { processed: 0, message: msg }
  }
  console.log(`[pipeline-step] research — ${targets.length} targets`)
  if (force) {
    const ids = targets.map((l) => l.id!).filter((x): x is number => !!x)
    await db.researchResults.where('leadId').anyOf(ids).and((r) => r.jobId === 0).delete().catch(() => {})
    await leadRepository.updateMany(ids, { status: 'selected' })
  }
  let queued = 0
  for (const l of targets) {
    if (await shouldStop()) break
    try { await addToResearchQueue(l); queued++ } catch { /* already queued */ }
    onProgress?.(queued, targets.length)
  }
  if (queued > 0) chrome.runtime.sendMessage({ type: MSG.TRIGGER_RESEARCH }).catch(() => {})
  const msg = `${queued} leads queued for research`
  console.log(`[pipeline-step] ✅ ${msg}`)
  toast.success(msg)
  return { processed: queued, message: msg }
}
