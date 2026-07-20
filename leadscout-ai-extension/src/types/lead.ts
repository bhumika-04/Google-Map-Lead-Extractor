export type LeadStatus =
  | 'new'
  | 'selected'
  | 'rejected'
  | 'research_pending'
  | 'research_running'
  | 'research_completed'
  | 'research_failed'

export type IcpStatus = 'high_fit' | 'good_fit' | 'low_priority' | 'hold' | 'reject'

export interface Lead {
  id?: number
  sessionId: number
  projectId?: number  // Search Session (searchProjects.id) this lead was captured in
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
  // ICP scoring fields — populated after Gemini validation
  icpScore?: number         // 0-100 integer ICP score
  icpStatus?: IcpStatus     // 'high_fit' | 'good_fit' | 'low_priority' | 'hold' | 'reject'
  icpReason?: string        // AI reason text
  icpScoreBreakdown?: string // e.g. "Industry:20 Scale:18 ERP:15 BizType:10 DM:7"
  // Enrichment fields — populated after AI pre-validation enrichment
  teamSize?: string              // e.g. "10-50", "Upto 10 People"
  teamSizeVerified?: boolean     // true = found in real web source; false/undefined = estimated
  annualTurnover?: string        // e.g. "₹40 Lakh" or "₹1-10 Cr (est)"
  turnoverVerified?: boolean     // true = found in real web source; false/undefined = estimated
  industry?: string              // e.g. "Label Printing"
  companyType?: string           // e.g. "Pvt Ltd"
  decisionMaker?: string         // owner/director names
  cin?: string                   // Corporate Identification Number (MCA, India only)
  uan?: string                   // Universal Account Number (EPFO, India only)
  country?: string               // ISO country code: 'IN' (default), 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', etc.
  // LinkedIn intelligence — populated after research pipeline visits the LinkedIn company page
  linkedinUrl?: string           // LinkedIn company page URL
  linkedinFollowers?: string     // e.g. "1,234"
  linkedinSpecialties?: string   // comma-separated e.g. "Label Printing, Flexo Packaging"
  linkedinAbout?: string         // full About / description text from LinkedIn
  linkedinPeople?: string        // JSON: { name, title, profileUrl? }[]
  linkedinRecentPost?: string    // JSON: { date, snippet }
  capturedAt: string
  updatedAt: string
  mssqlId?: string    // MSSQL companies.id (UUID) — set after first sync to the local API
}

export interface LeadFilter {
  sessionId?: number
  projectId?: number        // Search Session scope; -1 matches leads with no project set
  status?: LeadStatus
  statuses?: LeadStatus[]   // multi-status filter (overrides status when provided)
  city?: string
  country?: string          // ISO code; '??' matches leads with no country set
  keyword?: string
  searchQuery?: string
  minRating?: number
  hasPhone?: boolean
  hasWebsite?: boolean
  tag?: string
  hideNotRelevant?: boolean
  minIcpScore?: number      // Filter: only leads with icpScore >= this value
  hasTeamSize?: boolean     // Filter: only leads where teamSize is known
  hasTurnover?: boolean     // Filter: only leads where annualTurnover is known
}
