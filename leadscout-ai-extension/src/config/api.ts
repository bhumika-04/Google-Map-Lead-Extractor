// Single source of truth for the DeepLead API base URL.
//
// Default is the hosted backend, but it can be overridden AT RUNTIME from the
// extension UI (Backup & Restore → API Endpoint). The override is stored in
// chrome.storage.local and applied live across every context (dashboard +
// service worker) via the storage change listener below — no rebuild needed.
//
// API_BASE is a mutable `let` export: callers read `${API_BASE}/api/...` and,
// thanks to ESM live bindings, pick up runtime changes automatically.

export const DEFAULT_API_BASE = 'https://deeplead.indusanalytics.co.in'
const STORAGE_KEY = 'deeplead_api_base'

export let API_BASE = DEFAULT_API_BASE

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '') // strip trailing slashes; callers add /api/...
}

export function getApiBase(): string {
  return API_BASE
}

/** Persist a new API base and apply it live everywhere. Empty → reset to default. */
export async function setApiBase(url: string): Promise<string> {
  const clean = normalize(url) || DEFAULT_API_BASE
  API_BASE = clean
  try { await chrome.storage.local.set({ [STORAGE_KEY]: clean }) } catch { /* storage unavailable */ }
  return clean
}

export async function resetApiBase(): Promise<string> {
  return setApiBase(DEFAULT_API_BASE)
}

/** Load any saved override into API_BASE. Called once on module load per context. */
export async function loadApiBase(): Promise<string> {
  try {
    const o = await chrome.storage.local.get(STORAGE_KEY)
    const v = o?.[STORAGE_KEY]
    if (typeof v === 'string' && v.trim()) API_BASE = normalize(v)
  } catch { /* storage unavailable */ }
  return API_BASE
}

// Keep every context (dashboard, service worker) in sync the moment it changes.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && typeof changes[STORAGE_KEY]?.newValue === 'string') {
      API_BASE = normalize(String(changes[STORAGE_KEY].newValue))
    }
  })
} catch { /* not in an extension context */ }

// Seed from storage immediately on import.
loadApiBase()
