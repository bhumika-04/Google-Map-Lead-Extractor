// A Search Session (internally "project") — one per Start click in Search
// Console or per batch campaign. Groups every lead captured in that run so
// different domains (schools, pesticides, printing…) stay fully separate
// through the whole pipeline: Lead Database → validation → research →
// Company Intelligence. Also carries the business profile / ICP used to
// validate and research THIS run's leads, so switching domains never means
// overwriting a global prompt.

export type SearchProjectStatus = 'running' | 'completed' | 'stopped'

export interface SearchProject {
  id?: number
  name: string               // "Schools — India — 17 Jul 2026" (auto-generated, renamable)
  country: string            // ISO code e.g. 'IN'
  keywords: string[]         // original keyword list for the run
  cities: string[]
  businessProfile: string    // ICP prompt used for this run's validation + research
  status: SearchProjectStatus
  totalTerms: number         // keyword×city combinations queued
  completedTerms: number
  totalLeads: number         // captured (non-duplicate) leads across the run
  source: 'search_console' | 'batch_campaign'
  mssqlRunId?: number        // search_runs.id in MSSQL — set after first sync
  createdAt: string
  completedAt?: string
}
