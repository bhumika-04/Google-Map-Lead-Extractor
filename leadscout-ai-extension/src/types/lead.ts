export type LeadStatus =
  | 'new'
  | 'selected'
  | 'rejected'
  | 'research_pending'
  | 'research_running'
  | 'research_completed'
  | 'research_failed'

export interface Lead {
  id?: number
  sessionId: number
  companyName: string
  normalizedName: string
  category?: string
  rating?: number
  reviewCount?: number
  address?: string
  phone?: string
  website?: string
  googleMapsUrl?: string
  searchQuery: string
  city: string
  keyword: string
  source: 'google_maps' | 'indiamart' | 'justdial' | 'tradeindia' | 'google_search' | 'sql_restore'
  rawText?: string
  confidence: number
  status: LeadStatus
  notes?: string
  tags?: string[]
  validationStatus?: 'relevant' | 'not_relevant' | 'pending'
  validationReason?: string
  capturedAt: string
  updatedAt: string
}

export interface LeadFilter {
  sessionId?: number
  status?: LeadStatus
  city?: string
  keyword?: string
  searchQuery?: string
  minRating?: number
  hasPhone?: boolean
  hasWebsite?: boolean
  tag?: string
  hideNotRelevant?: boolean
}
