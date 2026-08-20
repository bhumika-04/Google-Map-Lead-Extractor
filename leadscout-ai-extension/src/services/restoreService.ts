import { db } from '@/db/db'
import { restoreFromSql } from '@/services/pipelineSyncService'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { nowISO } from '@/utils/date'
import type { SessionRecord } from '@/types/session'
import type { ScrapedLead } from '@/types/pipelineLead'
import type { Lead, LeadStatus } from '@/types/lead'
import type { SearchProjectStatus } from '@/types/searchProject'

// Restore-down: rebuild local Dexie from the new MSSQL schema via /api/restore.
// Populates BOTH the new tables (sessions / scrapedLeads / importedLeads) AND the
// legacy tables the session UIs still read (searchProjects + leads for scrape
// sessions) — so a fresh device shows sessions, cards, and the whole pipeline.
// Non-destructive: upserts by mssqlId / (project+name), so re-running merges.

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s.trim()) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

function toProjectStatus(s: string): SearchProjectStatus {
  return s === 'running' ? 'running' : s === 'stopped' ? 'stopped' : 'completed'
}

function toOldStatus(s: string): LeadStatus {
  switch (s) {
    case 'not_relevant':       return 'rejected'
    case 'research_queued':    return 'research_pending'
    case 'research_running':   return 'research_running'
    case 'research_completed': return 'research_completed'
    case 'research_failed':    return 'research_failed'
    case 'selected':           return 'selected'
    default:                   return 'new'
  }
}

function mapSession(row: any): SessionRecord {
  return {
    mssqlId: row.id,
    name: row.name ?? 'Session',
    source: row.source === 'import' ? 'import' : 'scrape',
    country: row.country ?? undefined,
    keywords: parseJson<string[]>(row.keywords_json, []),
    cities: parseJson<string[]>(row.cities_json, []),
    businessProfile: row.business_profile ?? '',
    status: row.status ?? 'completed',
    totalLeads: row.total_leads ?? 0,
    createdAt: row.created_at ?? nowISO(),
    completedAt: row.completed_at ?? undefined,
  }
}

function mapLead(row: any, localSessionId: number): ScrapedLead & { importFile?: string } {
  return {
    mssqlId: row.id,
    sessionId: localSessionId,
    companyName: row.company_name ?? '',
    normalizedName: row.normalized_name ?? '',
    category: row.category ?? undefined,
    rating: row.rating ?? undefined,
    reviewCount: row.review_count ?? undefined,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    googleMapsUrl: row.google_maps_url ?? undefined,
    mapScore: row.map_score ?? undefined,
    city: row.city ?? undefined,
    keyword: row.keyword ?? undefined,
    country: row.country ?? undefined,
    status: row.status ?? 'new',
    notes: row.notes ?? undefined,
    tags: parseJson<string[] | undefined>(row.tags_json, undefined),
    teamSize: row.team_size ?? undefined,
    annualTurnover: row.annual_turnover ?? undefined,
    industry: row.industry ?? undefined,
    decisionMaker: row.decision_maker ?? undefined,
    email: row.email ?? undefined,
    alternatePhone: row.alternate_phone ?? undefined,
    yearFounded: row.year_founded ?? undefined,
    companyType: row.company_type ?? undefined,
    employeeCount: row.employee_count ?? undefined,
    headquarters: row.headquarters ?? undefined,
    linkedin: row.linkedin ?? undefined,
    facebook: row.facebook ?? undefined,
    instagram: row.instagram ?? undefined,
    twitter: row.twitter ?? undefined,
    youtube: row.youtube ?? undefined,
    whatsapp: row.whatsapp ?? undefined,
    enrichment: parseJson(row.enrichment_json, undefined),
    enrichmentStatus: row.enrichment_status ?? 'pending',
    enrichmentConfidence: row.enrichment_confidence ?? undefined,
    enrichedAt: row.enriched_at ?? undefined,
    validationStatus: row.validation_status ?? undefined,
    icpScore: row.icp_score ?? undefined,
    icpStatus: row.icp_status ?? undefined,
    icpReason: row.icp_reason ?? undefined,
    scoreBreakdown: parseJson(row.score_breakdown_json, undefined),
    validatedAt: row.validated_at ?? undefined,
    researchStatus: row.research_status ?? 'none',
    researchSummary: row.research_summary ?? undefined,
    research: parseJson(row.research_json, undefined),
    researchConfidence: row.research_confidence ?? undefined,
    researchedAt: row.researched_at ?? undefined,
    importFile: row.import_file ?? undefined,
    capturedAt: row.captured_at ?? row.imported_at ?? nowISO(),
    updatedAt: row.updated_at ?? nowISO(),
  }
}

// Legacy `leads` row (so the workspace LeadTable + session cards, which read old
// leads, show restored scrape data).
function mapOldLead(row: any, projectId: number): Omit<Lead, 'id'> {
  return {
    sessionId: 0,
    projectId,
    companyName: row.company_name ?? '',
    normalizedName: row.normalized_name ?? '',
    category: row.category ?? undefined,
    rating: row.rating ?? undefined,
    reviewCount: row.review_count ?? undefined,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    googleMapsUrl: row.google_maps_url ?? undefined,
    searchQuery: '',
    city: row.city ?? '',
    keyword: row.keyword ?? '',
    source: 'google_maps',
    confidence: 0.9,
    status: toOldStatus(row.status ?? 'new'),
    validationStatus: row.validation_status ?? undefined,
    icpScore: row.icp_score ?? undefined,
    icpReason: row.icp_reason ?? undefined,
    teamSize: row.team_size ?? undefined,
    annualTurnover: row.annual_turnover ?? undefined,
    industry: row.industry ?? undefined,
    companyType: row.company_type ?? undefined,
    decisionMaker: row.decision_maker ?? undefined,
    country: row.country ?? undefined,
    capturedAt: row.captured_at ?? nowISO(),
    updatedAt: row.updated_at ?? nowISO(),
  }
}

export async function restoreFromNewSchema(): Promise<{ sessions: number; scraped: number; imported: number } | null> {
  const data = await restoreFromSql()
  if (!data) return null

  // ── Sessions → db.sessions (new) + searchProjects (old, scrape only) ────────
  const serverToLocalSession = new Map<number, number>()  // for new scrapedLeads
  const serverToLocalProject = new Map<number, number>()  // for old leads

  const existingSessions = await db.sessions.toArray()
  const sessionByMssql = new Map<number, number>(existingSessions.filter((s) => s.mssqlId != null).map((s) => [s.mssqlId!, s.id!]))

  const existingProjects = await searchProjectRepository.getAll().catch(() => [])
  const projectByMssql = new Map<number, number>(existingProjects.filter((p) => p.newSessionMssqlId != null).map((p) => [p.newSessionMssqlId!, p.id!]))

  for (const row of data.sessions ?? []) {
    const rec = mapSession(row)
    let localSessionId = sessionByMssql.get(rec.mssqlId!)
    if (localSessionId) await db.sessions.update(localSessionId, rec)
    else localSessionId = await db.sessions.add(rec)
    serverToLocalSession.set(rec.mssqlId!, localSessionId)

    if (rec.source === 'scrape') {
      let projectId = projectByMssql.get(rec.mssqlId!)
      if (!projectId) {
        projectId = await searchProjectRepository.create({
          name: rec.name, country: rec.country ?? 'IN',
          keywords: rec.keywords, cities: rec.cities,
          businessProfile: rec.businessProfile ?? '',
          status: toProjectStatus(rec.status),
          totalTerms: 0, completedTerms: 0, totalLeads: rec.totalLeads,
          source: 'search_console',
          newSessionId: localSessionId, newSessionMssqlId: rec.mssqlId,
        })
      }
      serverToLocalProject.set(rec.mssqlId!, projectId)
    }
  }

  // ── Scraped leads → db.scrapedLeads (new) + db.leads (old, per project) ──────
  const existingScraped = await db.scrapedLeads.toArray()
  const scrapedByMssql = new Map<number, number>(existingScraped.filter((l) => l.mssqlId != null).map((l) => [l.mssqlId!, l.id!]))
  const existingOld = await db.leads.toArray()
  const oldByKey = new Set(existingOld.map((l) => `${l.projectId ?? -1}|${l.normalizedName}`))

  let scraped = 0
  for (const row of data.scrapedLeads ?? []) {
    const localSession = serverToLocalSession.get(row.session_id)
    if (localSession === undefined) continue
    const rec = mapLead(row, localSession)
    const existingLocal = scrapedByMssql.get(rec.mssqlId!)
    if (existingLocal) await db.scrapedLeads.update(existingLocal, rec)
    else await db.scrapedLeads.add(rec)

    // Mirror into legacy leads for the session's project (dedupe by project+name).
    const projectId = serverToLocalProject.get(row.session_id)
    if (projectId !== undefined) {
      const key = `${projectId}|${rec.normalizedName}`
      if (!oldByKey.has(key)) { await db.leads.add(mapOldLead(row, projectId) as Lead); oldByKey.add(key) }
    }
    scraped++
  }

  // ── Imported leads → db.importedLeads (new; Lead Database reads this) ────────
  const existingImported = await db.importedLeads.toArray()
  const importedByMssql = new Map<number, number>(existingImported.filter((l) => l.mssqlId != null).map((l) => [l.mssqlId!, l.id!]))
  let imported = 0
  for (const row of data.importedLeads ?? []) {
    const localSession = serverToLocalSession.get(row.session_id)
    if (localSession === undefined) continue
    const rec = mapLead(row, localSession)
    const existingLocal = importedByMssql.get(rec.mssqlId!)
    if (existingLocal) await db.importedLeads.update(existingLocal, rec)
    else await db.importedLeads.add(rec)
    imported++
  }

  return { sessions: (data.sessions ?? []).length, scraped, imported }
}
