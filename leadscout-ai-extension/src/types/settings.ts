export interface SearchPreset {
  id: string
  name: string
  city: string
  keyword: string
  maxResults: number
}

export interface AppSettings {
  autoScrollDelay: number
  maxScrollAttempts: number
  noNewLeadStopThreshold: number
  defaultMaxResults: number
  capturePhone: boolean
  captureWebsite: boolean
  enableDebugLogs: boolean
  lastCity: string
  lastKeyword: string
  searchPresets: SearchPreset[]
  // Lead Validation
  businessProfile: string
  // Phase 2 — AI Research
  researchProvider: 'openai' | 'anthropic' | 'gemini'
  anthropicApiKey: string
  anthropicModel: string
  openAiApiKey: string
  openAiModel: string
  geminiApiKey: string
  geminiModel: string
  autoResearch: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoScrollDelay: 2000,
  maxScrollAttempts: 60,
  noNewLeadStopThreshold: 12,
  defaultMaxResults: 100,
  capturePhone: true,
  captureWebsite: true,
  enableDebugLogs: false,
  lastCity: '',
  lastKeyword: '',
  searchPresets: [],
  businessProfile: '',
  researchProvider: 'gemini',
  anthropicApiKey: '',
  anthropicModel: 'claude-haiku-4-5-20251001',
  openAiApiKey: '',
  openAiModel: 'gpt-4o-mini',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  autoResearch: false,
}
