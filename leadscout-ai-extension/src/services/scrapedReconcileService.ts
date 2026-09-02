import { searchProjectRepository } from '@/db/searchProjectRepository'
import { leadRepository } from '@/db/leadRepository'
import { scrapedLeadRepo } from '@/db/pipelineLeadRepository'
import { saveEnrichmentToSql, saveValidationBulkToSql, saveResearchToSql } from '@/services/pipelineSyncService'
import type { Lead } from '@/types/lead'
import type { ResearchResult } from '@/types/research'
import type { ScrapedLead, PipelineLeadStatus } from '@/types/pipelineLead'

function toNewScrapedLead(ol: Lead, sessionId: number): Omit<ScrapedLead, 'id' | 'capturedAt' | 'updatedAt'> & { capturedAt?: string } {
  return {
    sessionId,
    companyName: ol.companyName,
    normalizedName: ol.normalizedName,
    category: ol.category,
    rating: ol.rating,
    reviewCount: ol.reviewCount,
    address: ol.address,
    phone: ol.phone,
    website: ol.website,
    googleMapsUrl: ol.googleMapsUrl,
    city: ol.city,
    keyword: ol.keyword,
    country: ol.country,
    status: effectiveStatus(ol),
    enrichmentStatus: (ol.teamSize || ol.annualTurnover || ol.industry || ol.decisionMaker) ? 'done' : 'pending',
    researchStatus: 'none',
    teamSize: ol.teamSize,
    teamSizeVerified: ol.teamSizeVerified,
    teamSizeEstimate: ol.teamSizeEstimate,
    annualTurnover: ol.annualTurnover,
    turnoverVerified: ol.turnoverVerified,
    annualTurnoverEstimate: ol.annualTurnoverEstimate,
    industry: ol.industry,
    companyType: ol.companyType,
    decisionMaker: ol.decisionMaker,
    validationStatus: ol.validationStatus === 'relevant' || ol.validationStatus === 'not_relevant' ? ol.validationStatus : undefined,
    icpScore: ol.icpScore,
    icpStatus: ol.icpStatus,
    icpReason: ol.icpReason,
    capturedAt: ol.capturedAt,
  }
}

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

// Some older leads have validationStatus: 'relevant' (icpScore assigned) while
// their own status field was never promoted to 'selected' — a pre-existing
// data inconsistency from validation runs under older code, not something
// mapStatus alone can see. Treat validationStatus as authoritative for any
// lead whose status otherwise maps to plain 'new', so the mirror reflects
// what the AI actually decided rather than a stale/never-promoted status.
function effectiveStatus(ol: Lead): PipelineLeadStatus {
  const mapped = mapStatus(ol.status)
  if (mapped !== 'new') return mapped
  if (ol.validationStatus === 'relevant') return 'selected'
  if (ol.validationStatus === 'not_relevant') return 'not_relevant'
  return mapped
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
  // Match googleMapsUrl -> phone -> (normalizedName + city), same priority as
  // findScrapedMatch in SessionCsvImport.tsx. Matching by name alone collapses
  // same-named companies from different cities onto one scraped_leads row, so
  // every legacy lead but the last processed with that name silently never
  // gets its validation/enrichment fields mirrored — the workspace's
  // Scored/Relevant tiles then undercount even though the legacy `leads`
  // table and the live validation feed are both correct.
  const byUrl     = new Map(scraped.filter((s) => s.googleMapsUrl).map((s) => [s.googleMapsUrl!, s]))
  const byPhone   = new Map(scraped.filter((s) => s.phone).map((s) => [s.phone!, s]))
  const byNameCity = new Map(scraped.map((s) => [`${s.normalizedName}|${s.city ?? ''}`, s]))
  const findMatch = (ol: Lead): ScrapedLead | undefined =>
    (ol.googleMapsUrl && byUrl.get(ol.googleMapsUrl)) ||
    (ol.phone && byPhone.get(ol.phone)) ||
    byNameCity.get(`${ol.normalizedName}|${ol.city ?? ''}`)
  const validationItems: Array<{ mssqlId: number; lead: ScrapedLead }> = []

  for (const ol of oldLeads) {
    const sl = findMatch(ol)
    if (!sl?.id) {
      // No scraped_leads row exists at all for this legacy lead — it was
      // captured before city-aware matching was fixed and got silently
      // collapsed onto a different company's row instead of getting its own
      // (or never mirrored for some other reason). Create it now from the
      // legacy lead's own data so its validation/enrichment results, already
      // sitting correctly in the legacy table, finally have a mirror row to
      // land on — this is what backfills a session's undercounted
      // Scored/Relevant/Selected tiles without re-running the AI on anything.
      await scrapedLeadRepo.create(toNewScrapedLead(ol, sid)).catch(() => {})
      continue
    }

    const patch: Partial<ScrapedLead> = { status: effectiveStatus(ol) }

    const enriched = !!(ol.teamSize || ol.annualTurnover || ol.industry || ol.decisionMaker)
    if (enriched) {
      patch.teamSize = ol.teamSize
      patch.teamSizeVerified = ol.teamSizeVerified
      patch.teamSizeEstimate = ol.teamSizeEstimate
      patch.annualTurnover = ol.annualTurnover
      patch.turnoverVerified = ol.turnoverVerified
      patch.annualTurnoverEstimate = ol.annualTurnoverEstimate
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

// Mirror a completed research result for ONE lead into its scraped_leads row
// (local + new MSSQL). Called right after research finishes for a lead.
export async function mirrorResearchToScraped(lead: Lead, result: ResearchResult): Promise<void> {
  if (lead.projectId === undefined) return
  const project = await searchProjectRepository.getById(lead.projectId).catch(() => undefined)
  if (!project?.newSessionId) return
  const scraped = await scrapedLeadRepo.getBySession(project.newSessionId)
  const sl =
    (lead.googleMapsUrl && scraped.find((s) => s.googleMapsUrl === lead.googleMapsUrl)) ||
    (lead.phone && scraped.find((s) => s.phone === lead.phone)) ||
    scraped.find((s) => s.normalizedName === lead.normalizedName && (s.city ?? '') === (lead.city ?? ''))
  if (!sl?.id) return

  const patch: Partial<ScrapedLead> = {
    researchStatus: 'completed',
    researchSummary: result.summary,
    research: result as unknown as Record<string, unknown>,
    researchConfidence: result.confidence,
    decisionMaker: result.decisionMaker ?? sl.decisionMaker,
    email: result.email ?? sl.email,
    annualTurnover: result.annualTurnover ?? sl.annualTurnover,
    industry: result.industry ?? sl.industry,
    linkedin: result.linkedIn ?? sl.linkedin,
    facebook: result.facebook ?? sl.facebook,
    instagram: result.instagram ?? sl.instagram,
    twitter: result.twitter ?? sl.twitter,
    youtube: result.youtube ?? sl.youtube,
    whatsapp: result.whatsapp ?? sl.whatsapp,
    status: 'research_completed',
  }
  await scrapedLeadRepo.update(sl.id, patch).catch(() => {})
  if (sl.mssqlId) saveResearchToSql('scraped', sl.mssqlId, { ...sl, ...patch } as ScrapedLead).catch(() => {})
}

// Convenience: reconcile every distinct session touched by a set of leads.
export async function reconcileScrapedForLeads(leads: Lead[], phase: 'enrichment' | 'validation'): Promise<void> {
  const pids = [...new Set(leads.map((l) => l.projectId).filter((x): x is number => x !== undefined))]
  for (const pid of pids) await reconcileScrapedFromLeads(pid, phase).catch(() => {})
}
