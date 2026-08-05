import { searchProjectRepository } from '@/db/searchProjectRepository'
import { leadRepository } from '@/db/leadRepository'
import { scrapedLeadRepo } from '@/db/pipelineLeadRepository'
import { saveEnrichmentToSql, saveValidationBulkToSql } from '@/services/pipelineSyncService'
import type { Lead } from '@/types/lead'
import type { ScrapedLead, PipelineLeadStatus } from '@/types/pipelineLead'

// Mirror the pipeline fields the proven (legacy) path writes onto old `leads`
// into the new `scraped_leads` rows — locally AND to the new MSSQL — so the
// redesigned schema reflects enrichment + validation, not just capture.
// Additive: no read path changes, so it can't break the working UI.

function mapStatus(s: Lead['status']): PipelineLeadStatus {
  switch (s) {
    case 'rejected':           return 'not_relevant'
    case 'research_pending':   return 'research_queued'
    case 'selected':           return 'selected'
    case 'research_running':   return 'research_running'
    case 'research_completed': return 'research_completed'
    case 'research_failed':    return 'research_failed'
    default:                   return 'new'
  }
}

export async function reconcileScrapedFromLeads(
  projectId: number,
  phase: 'enrichment' | 'validation' = 'validation',
): Promise<void> {
  const project = await searchProjectRepository.getById(projectId).catch(() => undefined)
  if (!project?.newSessionId) return
  const sid = project.newSessionId

  const [oldLeads, scraped] = await Promise.all([
    leadRepository.getByFilter({ projectId }),
    scrapedLeadRepo.getBySession(sid),
  ])
  const byName = new Map(scraped.map((s) => [s.normalizedName, s]))
  const validationItems: Array<{ mssqlId: number; lead: ScrapedLead }> = []

  for (const ol of oldLeads) {
    const sl = byName.get(ol.normalizedName)
    if (!sl?.id) continue

    const patch: Partial<ScrapedLead> = { status: mapStatus(ol.status) }

    const enriched = !!(ol.teamSize || ol.annualTurnover || ol.industry || ol.decisionMaker)
    if (enriched) {
      patch.teamSize = ol.teamSize
      patch.annualTurnover = ol.annualTurnover
      patch.industry = ol.industry
      patch.companyType = ol.companyType
      patch.decisionMaker = ol.decisionMaker
      patch.enrichmentStatus = 'done'
    }
    if (ol.validationStatus === 'relevant' || ol.validationStatus === 'not_relevant') {
      patch.validationStatus = ol.validationStatus
      patch.icpScore = ol.icpScore
      patch.icpStatus = ol.icpStatus
      patch.icpReason = ol.icpReason
    }

    await scrapedLeadRepo.update(sl.id, patch).catch(() => {})

    const merged = { ...sl, ...patch } as ScrapedLead
    if (sl.mssqlId) {
      if (phase === 'enrichment' && enriched) {
        saveEnrichmentToSql('scraped', sl.mssqlId, merged).catch(() => {})
      }
      if (phase === 'validation' && patch.validationStatus) {
        validationItems.push({ mssqlId: sl.mssqlId, lead: merged })
      }
    }
  }

  if (phase === 'validation' && validationItems.length) {
    await saveValidationBulkToSql('scraped', validationItems).catch(() => {})
  }
}

// Convenience: reconcile every distinct session touched by a set of leads.
export async function reconcileScrapedForLeads(leads: Lead[], phase: 'enrichment' | 'validation'): Promise<void> {
  const pids = [...new Set(leads.map((l) => l.projectId).filter((x): x is number => x !== undefined))]
  for (const pid of pids) await reconcileScrapedFromLeads(pid, phase).catch(() => {})
}
