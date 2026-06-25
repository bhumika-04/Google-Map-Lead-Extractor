// Syncs captured leads + research results to the local DeepLead SQL API.
// The API runs on http://localhost:5150 and writes to the MSSQL 'deeplead' database.

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
  researchProvider: 'openai' | 'anthropic'
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
  }>
  enrichments: Array<{
    companyId: string
    website?: string
    email?: string
    linkedIn?: string
    facebook?: string
    instagram?: string
    youtube?: string
    decisionMaker?: string
    services?: string
    employeeCount?: string
    yearFounded?: string
    companyType?: string
    summary?: string
    confidence?: number
    enrichedAt?: string
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

// Save a batch of leads immediately after capture — direct per-action DB write
export async function saveLeadBatchToSql(
  city: string,
  keyword: string,
  leads: SyncLead[]
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/leads/save-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city, keyword, leads }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    // Best-effort — don't block capture flow
  }
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
): Promise<{ ok: boolean; synced?: number; error?: string }> {
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
    return { ok: true, synced: data.synced }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Connection failed' }
  }
}
