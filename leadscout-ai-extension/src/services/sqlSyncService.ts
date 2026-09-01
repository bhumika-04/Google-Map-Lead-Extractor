// Talks to the DeepLeadApi backend for config/credentials and the
// existing-clients list. Lead/session/enrichment/validation/research sync
// for the current schema lives in pipelineSyncService.ts
// (/api/sessions, /api/leads/{kind}/...) — this file used to also hold an
// older generation of sync functions (search_runs, /api/sync, /api/leads/save,
// /api/research/save, /api/deep-research/save, /api/linkedin/*, /api/restore
// in its pre-redesign shape) that targeted endpoints the backend no longer
// exposes. They were silent no-ops (every call wrapped in try/catch)  —
// removed rather than left as dead weight that looked like it was syncing.

import { API_BASE } from '@/config/api'

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

// appsettings.json (DeepLeadApi backend) is the PRIMARY key source — it's the
// one place meant to hold real credentials, so rotating a key only means
// editing one file and restarting the backend. The extension's own Settings
// page key is a fallback for when the backend is unreachable, NOT the other
// way around. (Previously local-first: a stale/wrong key entered once in the
// extension's Settings page would keep being used forever, silently shadowing
// a perfectly valid key in appsettings.json with no way to tell without
// digging through devtools.)
export async function resolveAiCredentials(settings: {
  researchProvider: 'gemini' | 'openai' | 'anthropic'
  geminiApiKey: string
  openAiApiKey: string
  anthropicApiKey: string
}): Promise<ResolvedAiCredentials> {
  const cfg = await fetchApiConfig()
  if (cfg?.hasKey) {
    return cfg.researchProvider === 'gemini'
      ? { provider: 'gemini', apiKey: cfg.geminiApiKey }
      : { provider: 'openai', apiKey: cfg.openAiApiKey }
  }

  const provider = settings.researchProvider
  const localKey =
    provider === 'openai'    ? settings.openAiApiKey :
    provider === 'anthropic' ? settings.anthropicApiKey :
    settings.geminiApiKey

  return { provider, apiKey: localKey }
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
