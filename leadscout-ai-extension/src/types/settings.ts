// Hardcoded ICP/validation prompt — no Settings UI entry required. Edit this
// directly in code to change what the AI considers a "relevant" lead.
export const DEFAULT_BUSINESS_PROFILE = `We sell Indus Print ERP / Printude — a specialized ERP and production automation suite built exclusively for the printing and packaging manufacturing industry. Our software covers AI-based cost estimation, job card generation, layout planning, die suggestions, shop-floor IoT machine tracking, and packaging controls (Packtude.AI). Key outcomes: 75% faster quoting, 15% reduction in substrate waste, and maximized machine utilization through intelligent scheduling.

Our product portfolio: Printude ERP, Indus Print ERP, inPrint, Print Pulse, Indus Paper ERP, Packtude.AI, InPulse IoT, plus HRM and CRM modules.
Our services: PPA-Framework training/education, BI Dashboard Development, Website Development, and Printpathshala (industry learning/content platform).

Ideal customers — verticals we serve:
Packaging converters: mono carton, rigid box, corrugated box manufacturers (Corrugation, Packaging)
Commercial offset printers running high-volume booklets, catalogs, corporate print (Commercial)
Flexo label manufacturers: roll-fed labels, shrink sleeves (Flexo Labels)
Publication and large-format printers (Publication, Large Format)
Company size: ₹1 Crore to ₹150+ Crore annual turnover, mid-to-large plants with 20+ employees
Decision makers: MD, Plant Head, Estimation Manager, Operations Director

NOT a fit — reject these:
Local copy/xerox shops, wedding card printers, T-shirt/mug customization shops
Pure digital design or creative agencies that outsource all physical printing
Non-print manufacturers (steel, plastics, textiles, pharma, food) — they need generic ERP, not print-specific
Micro print units below ₹1 Crore turnover with 1–2 manual machines and no IT infrastructure`

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
  lastCountry: string           // ISO code of last selected market, e.g. 'IN', 'AE'
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
  autoValidate: boolean               // After capture: run AI enrichment + ICP validation automatically
  autoResearchTopN: number            // After validation, queue top N relevant leads for research (0 = all)
  autoStartResearchAfterValidation: boolean  // Auto-start research queue after validation (false = wait for user click)
  theme: 'dark' | 'light'
  // Interakt — WhatsApp Business API
  interaktApiKey: string
  interaktTemplateName: string   // pre-approved WhatsApp template name in your Interakt account
  interaktCountryCode: string    // default +91
  // CRM Integration
  crmApiUrl: string
  crmApiKey: string
  crmAuthType: 'bearer' | 'api_key' | 'none'
}

export const DEFAULT_SETTINGS: AppSettings = {
  // Google Maps lazy-loads results in batches as you scroll — under sustained
  // automated use (e.g. a long sequential multi-keyword run), a fresh batch
  // can take noticeably longer than a couple seconds to arrive. The previous
  // defaults (2s delay, 12 no-growth ticks = 24s total patience) were giving
  // up on searches whose results were still loading, silently capturing far
  // fewer leads than actually existed. These are more patient by default —
  // no UI exists yet to tune them per-search, so the default has to be safe.
  autoScrollDelay: 3000,
  maxScrollAttempts: 100,
  noNewLeadStopThreshold: 20,
  defaultMaxResults: 100,
  capturePhone: true,
  captureWebsite: true,
  enableDebugLogs: false,
  lastCity: '',
  lastKeyword: '',
  lastCountry: 'IN',
  searchPresets: [],
  businessProfile: DEFAULT_BUSINESS_PROFILE,
  researchProvider: 'gemini',
  anthropicApiKey: '',
  anthropicModel: 'claude-haiku-4-5-20251001',
  openAiApiKey: '',
  openAiModel: 'gpt-4o-mini',
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  autoResearch: false,
  autoValidate: true,
  autoResearchTopN: 0,              // 0 = all relevant leads (not just top N)
  autoStartResearchAfterValidation: true,
  theme: 'dark',
  interaktApiKey: '',
  interaktTemplateName: '',
  interaktCountryCode: '+91',
  crmApiUrl: '',
  crmApiKey: '',
  crmAuthType: 'bearer',
}
