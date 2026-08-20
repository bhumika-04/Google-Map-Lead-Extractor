import { db } from '@/db/db'
import { restoreFromSql } from '@/services/pipelineSyncService'
import { nowISO } from '@/utils/date'
import type { SessionRecord } from '@/types/session'
import type { ScrapedLead } from '@/types/pipelineLead'

// Restore-down: rebuild local Dexie (sessions / scrapedLeads / importedLeads)
// from the new MSSQL schema via /api/restore. Non-destructive — upserts by
// mssqlId, so re-running merges rather than duplicating, and never wipes.

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s.trim()) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
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

async function restoreLeads(rows: any[], table: any, serverToLocalSession: Map<number, number>): Promise<number> {
  const existing: any[] = await table.toArray()
  const byMssql = new Map<number, number>(existing.filter((l) => l.mssqlId != null).map((l) => [l.mssqlId, l.id]))
  let n = 0
  for (const row of rows) {
    const localSession = serverToLocalSession.get(row.session_id)
    if (localSession === undefined) continue
    const rec = mapLead(row, localSession)
    const existingLocal = byMssql.get(rec.mssqlId!)
    if (existingLocal) await table.update(existingLocal, rec)
    else await table.add(rec)
    n++
  }
  return n
}

export async function restoreFromNewSchema(): Promise<{ sessions: number; scraped: number; imported: number } | null> {
  const data = await restoreFromSql()
  if (!data) return null

  // Sessions first — build server-id → local-id map so leads link correctly.
  const serverToLocal = new Map<number, number>()
  const existingSessions = await db.sessions.toArray()
  const byMssql = new Map<number, number>(existingSessions.filter((s) => s.mssqlId != null).map((s) => [s.mssqlId!, s.id!]))

  for (const row of data.sessions ?? []) {
    const rec = mapSession(row)
    let localId = byMssql.get(rec.mssqlId!)
    if (localId) await db.sessions.update(localId, rec)
    else localId = await db.sessions.add(rec)
    serverToLocal.set(rec.mssqlId!, localId)
  }

  const scraped = await restoreLeads(data.scrapedLeads ?? [], db.scrapedLeads, serverToLocal)
  const imported = await restoreLeads(data.importedLeads ?? [], db.importedLeads, serverToLocal)

  return { sessions: (data.sessions ?? []).length, scraped, imported }
}
