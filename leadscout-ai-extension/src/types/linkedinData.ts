// ── Types for the LinkedIn automated scraper ─────────────────────────────────
// "Not Available" is used (per the Phase 3 LinkedIn Business Intelligence spec)
// for any field that is not publicly visible on the page — never inferred.

export const NOT_AVAILABLE = 'Not Available'

/** Core team title taxonomy — step 5 of the spec, used for roleCategory classification */
export const CORE_ROLE_TITLES = [
  'Founder', 'Co-founder', 'MD', 'Managing Director', 'CEO', 'CTO', 'COO',
  'CGO', 'CFO', 'CMO', 'Director', 'Partner', 'Plant Head', 'Operations Head',
  'Production Head', 'Estimation Head', 'Purchase Head', 'HR Head',
  'Sales Head', 'Business Development Head',
] as const

export type CoreRoleTitle = typeof CORE_ROLE_TITLES[number]

export interface LinkedInCompanyProfile {
  companyName: string
  linkedinUrl: string
  industry: string
  companySize: string
  followers: string
  location: string
  aboutText: string
  loginRequired?: boolean
}

export interface LinkedInPost {
  author: string
  authorTitle: string
  authorProfileUrl: string
  content: string
  relativeDate: string
  /** ISO date string parsed from the post's <time datetime> attribute, when available */
  postDateIso: string | null
  daysAgo: number | null
  withinMonth: boolean
  /** Within the last 6 months — the window required by the spec (vs. withinMonth's 30-day window) */
  withinSixMonths: boolean
  likes: string
  comments: string
  /** Numeric likes + comments, when visibly parseable; null if not derivable */
  engagementCount: number | null
  postUrl: string
  mediaType: string
  urn: string

  // Deterministic, keyword-based signals — never AI-inferred (company posts)
  detectedTheme: string
  hiringSignal: boolean
  expansionSignal: boolean
  productSignal: boolean
  eventSignal: boolean

  // Deterministic signals — person posts only
  businessInterest?: string
  companyMention?: boolean
}

export interface LinkedInPerson {
  name: string
  title: string
  location: string
  profileUrl: string
  imageUrl: string
  isCore: boolean
  activityUrl: string
  /** Matched title from CORE_ROLE_TITLES, or 'Other' if not matched */
  roleCategory: string
  /** 0-1 — confidence of the roleCategory match (1.0 exact, lower for partial/keyword match) */
  confidence: number
}

export interface LinkedInPersonResult {
  person: LinkedInPerson
  posts: LinkedInPost[]
}

export type LiScraperStep =
  | 'company-profile'
  | 'company-posts'
  | 'company-people'
  | 'person-posts'
  | 'done'
  | 'error'

export interface LinkedInScraperJob {
  id: string
  leadId: number
  mssqlId?: string
  companyName: string
  /** Always ends with / — e.g. https://www.linkedin.com/company/shiv-offset/ */
  companyLinkedInUrl: string

  status: 'running' | 'done' | 'error' | 'cancelled'
  step: LiScraperStep
  /** Chrome tab that the scraper is controlling */
  tabId: number | null

  companyProfile: LinkedInCompanyProfile | null
  companyPosts: LinkedInPost[]
  teamMembers: LinkedInPerson[]
  personResults: LinkedInPersonResult[]

  /** Core members extracted from people tab — visited one by one */
  corePersons: LinkedInPerson[]
  currentPersonIndex: number

  startedAt: string
  completedAt?: string
  errorMsg?: string
  log: string[]
}
