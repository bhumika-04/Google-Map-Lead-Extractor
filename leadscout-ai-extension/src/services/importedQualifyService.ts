import { importedLeadRepo } from '@/db/pipelineLeadRepository'
import { validateLeads } from './leadValidationService'
import { resolveAiCredentials } from './sqlSyncService'
import { saveValidationToSql } from './pipelineSyncService'
import type { AppSettings } from '@/types/settings'
import type { ImportedLead } from '@/types/pipelineLead'

// Qualify imported leads: score each against the ICP (session profile, else the
// global one) and write validation_status / icp_score / icp_reason inline — the
// imported side's equivalent of the scraped pipeline's validation step.

export async function qualifyImportedLeads(
  settings: AppSettings,
  opts?: {
    sessionId?: number
    force?: boolean   // re-score everything, not just un-validated leads
    onProgress?: (done: number, total: number) => void
    shouldStop?: () => boolean | Promise<boolean>
  },
): Promise<number> {
  const { provider, apiKey } = await resolveAiCredentials(settings)
  if (!apiKey.trim()) return 0
  const shouldStop = opts?.shouldStop ?? (async () => false)

  const all = await importedLeadRepo.getAll()
  const targets = all.filter((l) =>
    (opts?.sessionId === undefined || l.sessionId === opts.sessionId) &&
    (opts?.force || l.validationStatus === undefined),
  )
  if (targets.length === 0) return 0

  // Group by session so each import batch is scored against its own ICP.
  const bySession = new Map<number, ImportedLead[]>()
  for (const l of targets) {
    const g = bySession.get(l.sessionId)
    if (g) g.push(l); else bySession.set(l.sessionId, [l])
  }

  const total = targets.length
  const CHUNK = 20
  let done = 0
  let updated = 0

  // Imported leads score against the current GLOBAL ICP (appsettings) — imports
  // don't carry a meaningful per-session ICP, and this guarantees the latest
  // prompt is used regardless of when the import session was created.
  const profile = settings.businessProfile.trim()
  if (!profile) return 0

  for (const [, group] of bySession) {
    if (await shouldStop()) break
    for (let i = 0; i < group.length; i += CHUNK) {
      if (await shouldStop()) return updated
      const chunk = group.slice(i, i + CHUNK)
      const results = await validateLeads(chunk as any, profile, apiKey, provider, () => {})
      for (const r of results) {
        const patch: Partial<ImportedLead> = {
          validationStatus: r.relevant ? 'relevant' : 'not_relevant',
          icpScore: r.icpScore,
          icpStatus: r.icpStatus,
          icpReason: r.reason,
          status: r.relevant ? 'selected' : 'not_relevant',
        }
        await importedLeadRepo.update(r.leadId, patch)
        const lead = chunk.find((c) => c.id === r.leadId)
        if (lead?.mssqlId) saveValidationToSql('imported', lead.mssqlId, { ...lead, ...patch } as ImportedLead).catch(() => {})
        updated++
      }
      done += chunk.length
      opts?.onProgress?.(done, total)
    }
  }

  return updated
}
