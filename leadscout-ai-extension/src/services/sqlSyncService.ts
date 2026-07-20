// Syncs captured leads + research results to the local DeepLead SQL API.
// The API runs on http://localhost:5150 and writes to the MSSQL 'deeplead' database.

import type { Lead } from '@/types/lead'
import type { ResearchResult } from '@/types/research'
import type { DeepResearch } from '@/types/deepResearch'
import type { LinkedInCompanyProfile, LinkedInPost, LinkedInPerson } from '@/types/linkedinData'

const API_BASE = 'http://localhost:5150'

export async function isApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

export interface ApiConfig {
  researchProvider: 'openai' | 'gemini'
  geminiApiKey: string
  geminiModel: string
  openAiApiKey: string
  openAiModel: string
  hasKey: boolean
}

export async function fetchApiConfig(): Promise<ApiConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/api/config`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return await res.json() as ApiConfig
  } catch {
    return null
  }
}

// Persists the ICP validation "Business Profile" prompt to appsettings.json's
// App:BusinessProfile key — the single source of truth (the extension has no
// local Settings storage for this field; see BACKEND_FIELDS in useSettingsStore.ts).
export async function saveBusinessProfile(businessProfile: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/config/business-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessProfile }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface ResolvedAiCredentials {
  provider: 'gemini' | 'openai' | 'anthropic'
  apiKey: string
}

// Prefers whatever key is already in extension Settings; falls back to the
// DeepLeadApi backend's appsettings.json (Gemini:ApiKey, or OpenAI:ApiKey if no
// Gemini key is set) so a key only needs to live in one place and never has to
// be typed into the UI.
export async function resolveAiCredentials(settings: {
  researchProvider: 'gemini' | 'openai' | 'anthropic'
  geminiApiKey: string
  openAiApiKey: string
  anthropicApiKey: string
}): Promise<ResolvedAiCredentials> {
  const provider = settings.researchProvider
  const localKey =
    provider === 'openai'    ? settings.openAiApiKey :
    provider === 'anthropic' ? settings.anthropicApiKey :
    settings.geminiApiKey

  if (localKey.trim()) return { provider, apiKey: localKey }

  const cfg = await fetchApiConfig()
  if (cfg?.hasKey) {
    return cfg.researchProvider === 'gemini'
      ? { provider: 'gemini', apiKey: cfg.geminiApiKey }
      : { provider: 'openai', apiKey: cfg.openAiApiKey }
  }

  return { provider, apiKey: '' }
}

export interface SyncLead {
  id: number
  companyName: string
  address?: string
  phone?: string
  website?: string
  googleMapsUrl?: string
  rating?: number
  reviewCount?: number
  category?: string
  city: string
}

export interface SyncResearchResult {
  leadId: number
  decisionMaker?: string
  email?: string
  website?: string
  linkedIn?: string
  facebook?: string
  instagram?: string
  youtube?: string
  summary?: string
  services?: string[]
  employeeCount?: string
  yearFounded?: number
  companyType?: string
  confidence?: number
  fullResultJson?: string   // Full serialised ResearchResult — enables complete reinstall restore
}

export interface SyncSession {
  city: string
  keyword: string
  totalCaptured: number
}

export interface RestoreData {
  companies: Array<{
    companyId: string
    companyName: string
    address?: string
    phone?: string
    website?: string
    googleMapsUrl?: string
    rating?: number
    reviewCount?: number
    category?: string
    city: string
    keyword?: string
    sessionName?: string
    sessionCreatedAt?: string
    validationStatus?: string   // MSSQL companies.validation_status
    enrichmentStatus?: string   // MSSQL companies.enrichment_status
    notes?: string
    tagsJson?: string           // JSON array string e.g. '["tag1","tag2"]'
    validationReason?: string
    runId?: number              // MSSQL search_runs.id — Search Session link
  }>
  enrichments: Array<{
    companyId: string
    website?: string
    email?: string
    alternatePhone?: string
    whatsapp?: string
    linkedIn?: string
    facebook?: string
    instagram?: string
    youtube?: string
    twitter?: string
    decisionMaker?: string
    decisionMakerLinkedIn?: string
    industry?: string
    tagline?: string
    services?: string
    employeeCount?: string
    yearFounded?: string
    companyType?: string
    supplierBuyerType?: string
    summary?: string
    annualTurnover?: string
    headquarters?: string
    teamMembersJson?: string
    certificationsJson?: string
    majorClientsJson?: string
    expansionSignalsJson?: string
    currentSoftwareJson?: string
    exportMarketsJson?: string
    painPointsJson?: string
    servicesJson?: string
    confidence?: number
    enrichedAt?: string
    fullResultJson?: string   // JSON-serialised ResearchResult — fast-path restore
  }>
  deepResearch?: Array<{
    companyId: string
    fullDeepResearchJson?: string
    recommendedPitch?: string
    pitchTemplate?: string
    researchedAt?: string
  }>
}

export async function restoreFromSql(): Promise<RestoreData | null> {
  try {
    const res = await fetch(`${API_BASE}/api/restore`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const data = await res.json()
    return data as RestoreData
  } catch {
    return null
  }
}

// Save a batch of leads immediately after capture — direct per-action DB write.
// runId tags every company with its Search Session (search_runs.id in MSSQL)
// so sessions survive a full restore from the database.
export async function saveLeadBatchToSql(
  city: string,
  keyword: string,
  leads: SyncLead[],
  runId?: number
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/leads/save-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city, keyword, leads, runId: runId ?? null }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    // Best-effort — don't block capture flow
  }
}

// ─── Search Sessions (search_runs) — MSSQL is the source of truth ────────────

export interface RemoteSearchRun {
  id: number
  name: string
  country?: string
  businessProfile?: string
  status?: string
  totalLeads?: number
  createdAt?: string
}

// Registers a Search Session in MSSQL; returns the new run id (or null if the
// API is down — the service worker lazily retries on the next capture start).
export async function createSearchRunInSql(run: {
  name: string
  country: string
  businessProfile: string
  status: string
}): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE}/api/search-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: run.name,
        country: run.country,
        businessProfile: run.businessProfile,
        status: run.status,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.id === 'number' ? data.id : null
  } catch {
    return null
  }
}

export async function updateSearchRunInSql(
  runId: number,
  patch: { name?: string; status?: string; totalLeads?: number; businessProfile?: string }
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/search-runs/${runId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(5000),
    })
  } catch { /* best-effort */ }
}

export async function fetchSearchRuns(): Promise<RemoteSearchRun[]> {
  try {
    const res = await fetch(`${API_BASE}/api/search-runs`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    return await res.json() as RemoteSearchRun[]
  } catch {
    return []
  }
}

// Save validation status for many leads in a single API call.
// Called after "Add N Relevant Leads to Selected" — passes mssqlId + status.
// Leads without mssqlId are silently skipped (they'll be caught on next full sync).
export async function saveValidationBulkToSql(
  updates: Array<{ mssqlId: string; status: 'selected' | 'not_relevant' }>
): Promise<void> {
  const eligible = updates.filter(u => !!u.mssqlId)
  if (!eligible.length) return
  try {
    await fetch(`${API_BASE}/api/leads/validate-bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: eligible.map(u => ({ mssqlId: u.mssqlId, status: u.status })) }),
      signal: AbortSignal.timeout(15000),
    })
  } catch { /* best-effort */ }
}

// Save ICP score + enrichment fields for many leads in one call.
export async function saveIcpBulkToSql(
  updates: Array<{
    mssqlId: string
    icpScore: number
    icpStatus: string
    icpReason: string
    icpScoreBreakdown?: string
    teamSize?: string
    annualTurnover?: string
    industry?: string
    companyType?: string
    decisionMaker?: string
  }>
): Promise<void> {
  const eligible = updates.filter(u => !!u.mssqlId)
  if (!eligible.length) return
  try {
    await fetch(`${API_BASE}/api/companies/batch-icp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: eligible }),
      signal: AbortSignal.timeout(15000),
    })
  } catch { /* best-effort */ }
}

// Save validation status for a single lead
export async function saveLeadValidationToSql(
  lead: SyncLead & { city: string; keyword: string; validationStatus: string }
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/leads/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Best-effort
  }
}

export async function syncToSql(
  session: SyncSession,
  leads: SyncLead[],
  researchResults: SyncResearchResult[]
): Promise<{ ok: boolean; synced?: number; leadIdMap?: Record<string, string>; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, leads, researchResults }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const txt = await res.text()
      return { ok: false, error: `API ${res.status}: ${txt}` }
    }

    const data = await res.json()
    // data.leadIdMap: { "indexedDbLeadId": "mssql-uuid", ... }
    return { ok: true, synced: data.synced, leadIdMap: data.leadIdMap ?? {} }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Connection failed' }
  }
}

// Called automatically after AI research completes — saves full enrichment to MSSQL.
// Uses lead.mssqlId if already synced, otherwise API will match by name+city.
// Best-effort: caller should .catch(() => {}) — never throws.
export async function saveResearchToSql(lead: Lead, result: ResearchResult): Promise<void> {
  await fetch(`${API_BASE}/api/research/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:          lead.companyName,
      city:                 lead.city,
      googleMapsUrl:        lead.googleMapsUrl ?? null,
      website:              result.website ?? null,
      email:                result.email ?? null,
      alternatePhone:       result.alternatePhone ?? null,
      whatsapp:             result.whatsapp ?? null,
      linkedIn:             result.linkedIn ?? null,
      facebook:             result.facebook ?? null,
      instagram:            result.instagram ?? null,
      youtube:              result.youtube ?? null,
      twitter:              result.twitter ?? null,
      decisionMaker:        result.decisionMaker ?? null,
      decisionMakerLinkedIn: result.decisionMakerLinkedIn ?? null,
      industry:             result.industry ?? null,
      tagline:              result.tagline ?? null,
      summary:              result.summary ?? null,
      companyType:          result.companyType ?? null,
      supplierType:         result.supplierBuyerType ?? null,
      employeeCount:        result.employeeCount ?? null,
      yearFounded:          result.yearFounded ?? null,
      annualTurnover:       result.annualTurnover ?? null,
      headquarters:         result.headquarters ?? null,
      teamMembersJson:      result.teamMembers    ? JSON.stringify(result.teamMembers)    : null,
      certificationsJson:   result.certifications ? JSON.stringify(result.certifications) : null,
      majorClientsJson:     result.majorClients   ? JSON.stringify(result.majorClients)   : null,
      expansionSignalsJson: result.expansionSignals ? JSON.stringify(result.expansionSignals) : null,
      currentSoftwareJson:  result.currentSoftware  ? JSON.stringify(result.currentSoftware)  : null,
      exportMarketsJson:    result.exportMarkets     ? JSON.stringify(result.exportMarkets)     : null,
      painPointsJson:       result.painPoints        ? JSON.stringify(result.painPoints)        : null,
      servicesJson:         result.services          ? JSON.stringify(result.services)          : null,
      confidence:           result.confidence ?? null,
      fullResultJson:       JSON.stringify(result),
    }),
    signal: AbortSignal.timeout(15000),
  })
}

// Called after deep research completes — saves social signals + pitch to MSSQL.
// Best-effort: caller should .catch(() => {}) — never throws.
export async function saveDeepResearchToSql(lead: Lead, dr: DeepResearch): Promise<void> {
  await fetch(`${API_BASE}/api/deep-research/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:          lead.companyName,
      city:                 lead.city,
      googleMapsUrl:        lead.googleMapsUrl ?? null,
      recommendedPitch:     dr.recommendedPitch ?? null,
      pitchTemplate:        dr.pitchTemplate ?? null,
      peopleActivityJson:   dr.peopleActivity  ? JSON.stringify(dr.peopleActivity)  : null,
      companySignalsJson:   dr.companySignals  ? JSON.stringify(dr.companySignals)  : null,
      intentSignalsJson:    dr.intentSignals   ? JSON.stringify(dr.intentSignals)   : null,
      fullDeepResearchJson: JSON.stringify(dr),
    }),
    signal: AbortSignal.timeout(15000),
  })
}

export interface ExistingClientUploadItem {
  companyName: string
  city?: string
  phone?: string
  contactName?: string
  email?: string
  notes?: string
}

// Uploads a batch of existing-clients/already-in-touch rows (deduped server-side
// by phone OR normalized name+city). Best-effort — caller should handle [] as failure.
export async function uploadExistingClientsBatch(
  clients: ExistingClientUploadItem[]
): Promise<{ ok: boolean; saved: number; skipped: number }> {
  if (clients.length === 0) return { ok: true, saved: 0, skipped: 0 }
  try {
    const res = await fetch(`${API_BASE}/api/existing-clients/upload-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clients }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { ok: false, saved: 0, skipped: clients.length }
    const data = await res.json()
    return { ok: true, saved: data.saved ?? 0, skipped: data.skipped ?? 0 }
  } catch {
    return { ok: false, saved: 0, skipped: clients.length }
  }
}

export interface RemoteExistingClient {
  mssqlId: string
  companyName: string
  normalizedName: string
  city?: string
  phone?: string
  normalizedPhone?: string
  contactName?: string
  email?: string
  notes?: string
  uploadedAt: string
}

// MSSQL is the source of truth for existing clients too — fetch on dashboard open.
export async function fetchExistingClients(): Promise<RemoteExistingClient[]> {
  try {
    const res = await fetch(`${API_BASE}/api/existing-clients`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const data = await res.json()
    return (data.clients ?? []) as RemoteExistingClient[]
  } catch {
    return []
  }
}

export async function deleteExistingClient(mssqlId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/existing-clients/${mssqlId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000),
    })
    return res.ok
  } catch {
    return false
  }
}

// Save notes, tags, or validationReason for a lead by mssqlId.
// Best-effort — caller should .catch(() => {}).
export async function saveLeadMetaToSql(
  mssqlId: string,
  meta: { notes?: string; tags?: string[]; validationReason?: string }
): Promise<void> {
  if (!mssqlId) return
  await fetch(`${API_BASE}/api/leads/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mssqlId,
      notes:            meta.notes            ?? null,
      tagsJson:         meta.tags             ? JSON.stringify(meta.tags) : null,
      validationReason: meta.validationReason ?? null,
    }),
    signal: AbortSignal.timeout(5000),
  })
}

// ─── LinkedIn Business Intelligence (Phase 3) ─────────────────────────────────
// Company is resolved server-side by name+city / googleMapsUrl, same convention
// as saveResearchToSql/saveDeepResearchToSql. All calls are best-effort —
// callers should .catch(() => {}).

export async function saveLinkedInCompanyProfile(lead: Lead, profile: LinkedInCompanyProfile): Promise<void> {
  await fetch(`${API_BASE}/api/linkedin/company-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:   lead.companyName,
      city:          lead.city,
      googleMapsUrl: lead.googleMapsUrl ?? null,
      linkedinUrl:   profile.linkedinUrl,
      industry:      profile.industry,
      companySize:   profile.companySize,
      followers:     profile.followers,
      location:      profile.location,
      aboutText:     profile.aboutText,
    }),
    signal: AbortSignal.timeout(15000),
  })
}

export async function saveLinkedInCompanyPosts(lead: Lead, posts: LinkedInPost[]): Promise<void> {
  if (posts.length === 0) return
  await fetch(`${API_BASE}/api/linkedin/company-posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:   lead.companyName,
      city:          lead.city,
      googleMapsUrl: lead.googleMapsUrl ?? null,
      posts: posts.map(p => ({
        postDate:         p.postDateIso ?? p.relativeDate,
        postText:         p.content,
        postUrl:          p.postUrl || null,
        engagementCount:  p.engagementCount,
        detectedTheme:    p.detectedTheme,
        hiringSignal:     p.hiringSignal,
        expansionSignal:  p.expansionSignal,
        productSignal:    p.productSignal,
        eventSignal:      p.eventSignal,
        withinSixMonths:  p.withinSixMonths,
      })),
    }),
    signal: AbortSignal.timeout(20000),
  })
}

export async function saveLinkedInPeople(lead: Lead, people: LinkedInPerson[]): Promise<void> {
  if (people.length === 0) return
  await fetch(`${API_BASE}/api/linkedin/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:   lead.companyName,
      city:          lead.city,
      googleMapsUrl: lead.googleMapsUrl ?? null,
      people: people.map(p => ({
        name:        p.name,
        title:       p.title,
        linkedinUrl: p.profileUrl,
        roleCategory: p.roleCategory,
        confidence:   p.confidence,
      })),
    }),
    signal: AbortSignal.timeout(20000),
  })
}

export async function saveLinkedInPersonPosts(lead: Lead, person: LinkedInPerson, posts: LinkedInPost[]): Promise<void> {
  if (posts.length === 0) return
  await fetch(`${API_BASE}/api/linkedin/person-posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName:    lead.companyName,
      city:           lead.city,
      googleMapsUrl:  lead.googleMapsUrl ?? null,
      personLinkedinUrl: person.profileUrl,
      personName:        person.name,
      posts: posts.map(p => ({
        postDate:         p.postDateIso ?? p.relativeDate,
        postText:         p.content,
        postUrl:          p.postUrl || null,
        detectedTheme:    p.detectedTheme,
        businessInterest: p.businessInterest ?? null,
        hiringSignal:     p.hiringSignal,
        companyMention:   p.companyMention ?? false,
        withinSixMonths:  p.withinSixMonths,
      })),
    }),
    signal: AbortSignal.timeout(20000),
  })
}

export interface LinkedInIntelligence {
  companyProfile: (LinkedInCompanyProfile & { capturedAt: string }) | null
  companyPosts: Array<{
    postDate: string; postText: string; postUrl: string | null; engagementCount: number | null
    detectedTheme: string; hiringSignal: boolean; expansionSignal: boolean; productSignal: boolean; eventSignal: boolean
  }>
  people: Array<{
    name: string; title: string; linkedinUrl: string; roleCategory: string; confidence: number
  }>
  personPosts: Array<{
    personName: string; personLinkedinUrl: string; postDate: string; postText: string; postUrl: string | null
    detectedTheme: string; businessInterest: string | null; hiringSignal: boolean; companyMention: boolean
  }>
}

// leadId here is the MSSQL company GUID (lead.mssqlId), consistent with /api/outreach/{companyId}.
export async function fetchLinkedInIntelligence(mssqlId: string): Promise<LinkedInIntelligence | null> {
  if (!mssqlId) return null
  try {
    const res = await fetch(`${API_BASE}/api/leads/${mssqlId}/linkedin-intelligence`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    return await res.json() as LinkedInIntelligence
  } catch {
    return null
  }
}
