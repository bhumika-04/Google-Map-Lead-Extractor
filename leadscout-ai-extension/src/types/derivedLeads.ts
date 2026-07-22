// Snapshots for the dedicated per-stage tables. These are MATERIALIZED from the
// master `leads` table (+ researchResults) — `leads` remains the single source of
// truth, so these can always be rebuilt and never hold the only copy of anything.

export interface SelectedLead {
  leadId: number          // primary key — same id as the master lead row
  projectId?: number      // Search Session this lead belongs to
  companyName: string
  city?: string
  phone?: string
  website?: string
  category?: string
  rating?: number
  icpScore?: number
  icpStatus?: string
  status: string          // the master lead's status (selected / research_*)
  validationReason?: string
  selectedAt: string
}

export interface ResearchedLead {
  leadId: number          // primary key — same id as the master lead row
  projectId?: number
  companyName: string
  city?: string
  decisionMaker?: string
  email?: string
  phone?: string
  website?: string
  industry?: string
  annualTurnover?: string
  teamSize?: string
  confidence?: number
  researchedAt: string
}
