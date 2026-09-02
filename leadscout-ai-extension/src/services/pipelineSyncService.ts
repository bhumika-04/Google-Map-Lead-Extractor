import { API_BASE } from '@/config/api'
import type { SessionRecord } from '@/types/session'
import type { PipelineLead } from '@/types/pipelineLead'

// Sync layer for the redesigned schema — talks to the new API
// (/api/sessions, /api/leads/{kind}/…, /api/restore). Best-effort: every call
// swallows errors and returns a safe fallback, because the extension is
// offline-first (Dexie is the source of truth; MSSQL is the durable mirror).

export type LeadKind = 'scraped' | 'imported'

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const text = await res.text()
    return text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    return null
  }
}

export async function isApiUp(): Promise<boolean> {
  const r = await req<{ ok: boolean }>('GET', '/api/health', undefined, 3000)
  return !!r?.ok
}

// ─── Sessions ────────────────────────────────────────────────────────────────
export async function createSessionInSql(s: SessionRecord): Promise<number | null> {
  const r = await req<{ id: number }>('POST', '/api/sessions', {
    name: s.name,
    source: s.source,
    country: s.country ?? null,
    keywords: s.keywords ?? [],
    cities: s.cities ?? [],
    businessProfile: s.businessProfile ?? null,
    status: s.status,
  })
  return r?.id ?? null
}

export async function updateSessionInSql(mssqlId: number, patch: Partial<Pick<SessionRecord, 'name' | 'status' | 'businessProfile' | 'totalLeads'>>): Promise<void> {
  await req('PUT', `/api/sessions/${mssqlId}`, {
    name: patch.name ?? null,
    status: patch.status ?? null,
    businessProfile: patch.businessProfile ?? null,
    totalLeads: patch.totalLeads ?? null,
  })
}

export async function deleteSessionInSql(mssqlId: number): Promise<void> {
  await req('DELETE', `/api/sessions/${mssqlId}`)
}

// ─── Lead capture (batch upsert) ─────────────────────────────────────────────
function toLeadDto(l: PipelineLead & { sourceRow?: Record<string, string> }) {
  return {
    companyName: l.companyName,
    normalizedName: l.normalizedName,
    category: l.category ?? null,
    rating: l.rating ?? null,
    reviewCount: l.reviewCount ?? null,
    address: l.address ?? null,
    phone: l.phone ?? null,
    website: l.website ?? null,
    googleMapsUrl: l.googleMapsUrl ?? null,
    mapScore: l.mapScore ?? null,
    city: l.city ?? null,
    keyword: l.keyword ?? null,
    country: l.country ?? null,
    status: l.status ?? 'new',
    notes: l.notes ?? null,
    tagsJson: l.tags && l.tags.length ? JSON.stringify(l.tags) : null,
    sourceRowJson: (l as any).sourceRow ? JSON.stringify((l as any).sourceRow) : null,
  }
}

/** Upsert a capture batch; returns normalizedName → server id so callers can backfill mssqlId. */
export async function saveLeadBatchToSql(
  kind: LeadKind,
  sessionMssqlId: number,
  leads: PipelineLead[],
  importFile?: string,
): Promise<Record<string, number>> {
  const r = await req<{ saved: number; ids: { normalizedName: string; id: number }[] }>(
    'POST', `/api/leads/${kind}/save-batch`,
    { sessionId: sessionMssqlId, importFile: importFile ?? null, leads: leads.map(toLeadDto) },
    30000,
  )
  const map: Record<string, number> = {}
  for (const row of r?.ids ?? []) map[row.normalizedName] = row.id
  return map
}

// ─── Enrichment / validation / research ──────────────────────────────────────
export async function saveEnrichmentToSql(kind: LeadKind, leadMssqlId: number, l: PipelineLead): Promise<void> {
  await req('PUT', `/api/leads/${kind}/${leadMssqlId}/enrichment`, {
    teamSize: l.teamSize ?? null, annualTurnover: l.annualTurnover ?? null, industry: l.industry ?? null,
    decisionMaker: l.decisionMaker ?? null, email: l.email ?? null, alternatePhone: l.alternatePhone ?? null,
    yearFounded: l.yearFounded ?? null, companyType: l.companyType ?? null, employeeCount: l.employeeCount ?? null,
    headquarters: l.headquarters ?? null, linkedIn: l.linkedin ?? null, facebook: l.facebook ?? null,
    instagram: l.instagram ?? null, twitter: l.twitter ?? null, youtube: l.youtube ?? null, whatsapp: l.whatsapp ?? null,
    enrichmentJson: l.enrichment ? JSON.stringify(l.enrichment) : null,
    confidence: l.enrichmentConfidence ?? null,
    teamSizeVerified: l.teamSizeVerified ?? null, teamSizeEstimate: l.teamSizeEstimate ?? null,
    turnoverVerified: l.turnoverVerified ?? null, annualTurnoverEstimate: l.annualTurnoverEstimate ?? null,
  })
}

export async function saveValidationToSql(kind: LeadKind, leadMssqlId: number, l: PipelineLead): Promise<void> {
  await req('PUT', `/api/leads/${kind}/${leadMssqlId}/validation`, {
    validationStatus: l.validationStatus ?? null, icpScore: l.icpScore ?? null, icpStatus: l.icpStatus ?? null,
    icpReason: l.icpReason ?? null,
    scoreBreakdownJson: l.scoreBreakdown ? JSON.stringify(l.scoreBreakdown) : null,
  })
}

export async function saveValidationBulkToSql(
  kind: LeadKind,
  items: Array<{ mssqlId: number; lead: PipelineLead }>,
): Promise<void> {
  await req('POST', `/api/leads/${kind}/validate-bulk`, {
    items: items.map(({ mssqlId, lead }) => ({
      id: mssqlId,
      validationStatus: lead.validationStatus ?? null,
      icpScore: lead.icpScore ?? null,
      icpStatus: lead.icpStatus ?? null,
      icpReason: lead.icpReason ?? null,
      scoreBreakdownJson: lead.scoreBreakdown ? JSON.stringify(lead.scoreBreakdown) : null,
    })),
  })
}

export async function saveResearchToSql(kind: LeadKind, leadMssqlId: number, l: PipelineLead): Promise<void> {
  await req('PUT', `/api/leads/${kind}/${leadMssqlId}/research`, {
    researchStatus: l.researchStatus ?? 'completed',
    researchSummary: l.researchSummary ?? null,
    researchJson: l.research ? JSON.stringify(l.research) : null,
    confidence: l.researchConfidence ?? null,
    decisionMaker: l.decisionMaker ?? null, email: l.email ?? null, annualTurnover: l.annualTurnover ?? null,
    teamSize: l.teamSize ?? null, industry: l.industry ?? null,
    linkedIn: l.linkedin ?? null, facebook: l.facebook ?? null, instagram: l.instagram ?? null,
    twitter: l.twitter ?? null, youtube: l.youtube ?? null, whatsapp: l.whatsapp ?? null,
  })
}

export async function saveStatusToSql(kind: LeadKind, leadMssqlId: number, status: string): Promise<void> {
  await req('PUT', `/api/leads/${kind}/${leadMssqlId}/status`, { status })
}

// ─── Restore (sync-down) ─────────────────────────────────────────────────────
export interface RestorePayload {
  sessions: any[]
  scrapedLeads: any[]
  importedLeads: any[]
}
export async function restoreFromSql(): Promise<RestorePayload | null> {
  return req<RestorePayload>('GET', '/api/restore', undefined, 30000)
}
