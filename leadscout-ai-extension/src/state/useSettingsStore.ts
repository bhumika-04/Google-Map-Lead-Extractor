import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings } from '@/types/settings'
import { db } from '@/db/db'

import { API_BASE } from '@/config/api'

// Fields that come from the backend — overwrite local values whenever backend is reachable.
// UI-only prefs (theme, lastCity, searchPresets) stay in IndexedDB.
const BACKEND_FIELDS: (keyof AppSettings)[] = [
  'researchProvider', 'geminiApiKey', 'geminiModel',
  'openAiApiKey', 'openAiModel',
  'anthropicApiKey', 'anthropicModel',
  'businessProfile',
  'interaktApiKey', 'interaktTemplateName', 'interaktCountryCode',
  'crmApiUrl', 'crmApiKey', 'crmAuthType',
]

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

async function persistSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app_settings', value: JSON.stringify(settings) })
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    // 1. Load local prefs from IndexedDB (theme, lastCity, presets, etc.)
    let merged: AppSettings = { ...DEFAULT_SETTINGS }
    try {
      const record = await db.settings.get('app_settings')
      if (record) {
        const local = JSON.parse(record.value) as Partial<AppSettings>
        merged = { ...merged, ...local }
      }
    } catch {}

    // 2. Override sensitive config from backend — no manual key entry needed
    let backendReachable = false
    try {
      const res = await fetch(`${API_BASE}/api/config`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        backendReachable = true
        const cfg = await res.json() as Record<string, string>
        for (const field of BACKEND_FIELDS) {
          const v = cfg[field]
          if (v !== undefined && v !== null && v !== '') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(merged as any)[field] = v
          }
        }
      }
    } catch {
      // Backend offline — keep local/default values
    }

    if (!merged.businessProfile?.trim()) merged.businessProfile = DEFAULT_SETTINGS.businessProfile
    set({ settings: merged, loaded: true })

    // load() only runs once on mount — if the backend happened to be down at
    // that exact moment (e.g. `dotnet run` still starting), the dashboard
    // would otherwise be stuck on a stale local fallback (empty or wrong key)
    // for the rest of the tab's lifetime, even after the backend comes back
    // online seconds later. Keep retrying quietly until it's reachable.
    if (!backendReachable) {
      setTimeout(() => { get().load() }, 15000)
    }
  },

  // update() is only used for transient UI prefs (lastCity, searchPresets, theme).
  // API keys and business profile come from the backend; don't persist them locally.
  async update(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    // Only persist non-backend fields to IndexedDB
    const toSave: Partial<AppSettings> = {}
    for (const [k, v] of Object.entries(next) as [keyof AppSettings, unknown][]) {
      if (!BACKEND_FIELDS.includes(k)) (toSave as Record<string, unknown>)[k] = v
    }
    await persistSettings({ ...DEFAULT_SETTINGS, ...toSave } as AppSettings)
  },
}))
