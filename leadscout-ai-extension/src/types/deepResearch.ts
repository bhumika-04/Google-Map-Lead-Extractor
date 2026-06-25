export type SocialPlatform = 'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'youtube' | 'news' | 'web'

export interface SocialPost {
  platform: SocialPlatform
  date?: string
  headline?: string
  snippet: string
  url?: string
}

export interface PersonActivity {
  name: string
  role: string
  linkedInUrl?: string
  posts: SocialPost[]
  topics: string[]
  activitySummary: string
  bestApproach?: string
}

export interface DeepResearch {
  id?: number
  researchResultId: number
  leadId: number
  peopleActivity: PersonActivity[]
  companySignals: string[]
  intentSignals: string[]
  recommendedPitch: string
  pitchTemplate?: string
  researchedAt: string
}
