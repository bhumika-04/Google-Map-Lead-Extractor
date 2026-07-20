export type DetectedType =
  | 'official_website'
  | 'corporate_registry'
  | 'google_ai'          // Google AI Mode answer for the lead (synthetic source page)
  | 'linkedin'
  | 'facebook'
  | 'instagram'
  | 'youtube'
  | 'indiamart'
  | 'tradeindia'
  | 'zaubacorp'
  | 'ambitionbox'
  | 'company_directory'
  | 'news'
  | 'review_site'
  | 'unknown'

/** Why a source could not be scraped. Set instead of bypassing the restriction. */
export type BlockedReason =
  | 'login_required'
  | 'forbidden'
  | 'captcha'
  | 'robots'
  | 'not_found'
  | 'unsupported'

export interface SearchEvidence {
  id?: number
  leadId: number
  sessionId: number
  query: string
  /** ISO 639-1 language the query was issued in (en, ar, …) */
  queryLanguage?: string
  title: string
  url: string
  displayUrl: string
  snippet: string
  rank: number
  sourceDomain: string
  detectedType: DetectedType
  matchConfidence: number       // name-match score 0-1
  /** Composite ranking score (name + locality + type trust) — higher = visit first */
  rankScore?: number
  rejected: boolean
  rejectReason?: string
  capturedAt: string
}

export type SourcePageStatus = 'pending' | 'fetched' | 'extracted' | 'failed' | 'blocked'

export interface SourcePage {
  id?: number
  leadId: number
  evidenceId?: number
  url: string
  sourceDomain: string
  sourceType: DetectedType
  pageTitle?: string
  /** Original page text exactly as fetched — never overwritten by translation */
  rawText?: string
  /** ISO 639-1 code of the dominant language detected in rawText */
  detectedLanguage?: string
  extractedJson?: string        // JSON.stringify of this page's AI extraction (English values + original quotes)
  confidence?: number
  status: SourcePageStatus
  /** Set when status === 'blocked' — the restriction is respected, never bypassed */
  blockedReason?: BlockedReason
  errorMessage?: string
  capturedAt: string
}

export interface CompanyResearch {
  id?: number
  leadId: number
  companyName: string
  officialWebsite?: string
  linkedinUrl?: string
  facebookUrl?: string
  instagramUrl?: string
  indiamartUrl?: string
  tradeindiaUrl?: string
  ownerName?: string
  directors?: string
  productsServices?: string
  businessType?: string
  teamSize?: string
  turnover?: string
  establishedYear?: number
  address?: string
  phone?: string
  email?: string
  confidence: number
  sourcesJson?: string           // { field: sourcePageId } attribution map
  createdAt: string
  updatedAt: string
}
