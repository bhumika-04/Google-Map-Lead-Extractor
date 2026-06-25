import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings } from '@/types/settings'
import { db } from '@/db/db'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  reset: () => Promise<void>
}

async function persistSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app_settings', value: JSON.stringify(settings) })
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    const record = await db.settings.get('app_settings')
    if (record) {
      const parsed = JSON.parse(record.value) as AppSettings
      set({ settings: { ...DEFAULT_SETTINGS, ...parsed }, loaded: true })
    } else {
      set({ loaded: true })
    }
  },

  async update(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    await persistSettings(next)
  },

  async reset() {
    set({ settings: DEFAULT_SETTINGS })
    await persistSettings(DEFAULT_SETTINGS)
  },
}))
