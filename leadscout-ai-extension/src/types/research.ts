export interface ResearchResult {
  id?: number
  leadId: number
  jobId: number
  // Contact
  decisionMaker?: string
  decisionMakerLinkedIn?: string
  email?: string
  alternatePhone?: string
  // Social media
  website?: string
  linkedIn?: string
  facebook?: string
  instagram?: string
  twitter?: string
  youtube?: string
  whatsapp?: string
  // Business details
  summary?: string
  tagline?: string
  services?: string[]
  employeeCount?: string
  annualTurnover?: string
  yearFounded?: number
  companyType?: string
  industry?: string
  headquarters?: string
  certifications?: string[]
  majorClients?: string[]
  supplierBuyerType?: 'manufacturer' | 'trader' | 'distributor' | 'service_provider' | 'mixed'
  exportMarkets?: string[]
  currentSoftware?: string[]
  expansionSignals?: string[]
  // Buyer persona
  painPoints?: string[]
  // Key people
  teamMembers?: { name: string; role: string }[]
  confidence: number
  sourceUrl?: string
  createdAt: string
}

export type ResearchJobType =
  | 'company_profile'
  | 'website_research'
  | 'social_profiles'
  | 'decision_makers'
  | 'business_persona'

export type ResearchJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ResearchJob {
  id?: number
  leadId: number
  sessionId: number
  companyName: string
  jobType: ResearchJobType
  status: ResearchJobStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  resultJson?: string
  errorMessage?: string
}
