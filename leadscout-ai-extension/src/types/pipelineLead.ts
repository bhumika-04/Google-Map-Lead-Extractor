// The unified lead shape for the redesigned schema. One row carries a lead's
// FULL lifecycle inline (capture -> enrichment -> validation -> research),
// mirroring the MSSQL scraped_leads / imported_leads tables.
//
//   ScrapedLead   = automation output (Google Maps)   -> db.scrapedLeads
//   ImportedLead  = CSV/Excel upload (+ import fields) -> db.importedLeads
//
// "Validated" / "researched" leads are STATES of a row (status columns), never
// separate records — matching the server design.

export type PipelineLeadStatus =
  | 'new'
  | 'selected'
  | 'not_relevant'
  | 'research_queued'
  | 'research_running'
  | 'research_completed'
  | 'research_failed'

export type EnrichmentStatus = 'pending' | 'done' | 'failed' | 'skipped'
export type ValidationStatus = 'relevant' | 'not_relevant'
export type ResearchStatus = 'none' | 'queued' | 'running' | 'completed' | 'failed'

// Open-ended enrichment arrays — serialized to enrichment_json for MSSQL.
export interface EnrichmentExtra {
  services?: string[]
  certifications?: string[]
  majorClients?: string[]
  teamMembers?: { name: string; role: string }[]
  painPoints?: string[]
  expansionSignals?: string[]
  currentSoftware?: string[]
}

export interface PipelineLead {
  id?: number
  mssqlId?: number          // scraped_leads/imported_leads id in MSSQL — set after sync
  sessionId: number

  // Core (capture)
  companyName: string
  normalizedName: string
  category?: string
  rating?: number
  reviewCount?: number
  address?: string
  phone?: string
  website?: string
  googleMapsUrl?: string
  mapScore?: number
  city?: string
  keyword?: string
  country?: string

  // Pipeline state
  status: PipelineLeadStatus
  notes?: string
  tags?: string[]

  // Enrichment (AI) — scalar
  teamSize?: string
  annualTurnover?: string
  industry?: string
  decisionMaker?: string
  email?: string
  alternatePhone?: string
  yearFounded?: number
  companyType?: string
  employeeCount?: string
  headquarters?: string
  linkedin?: string
  facebook?: string
  instagram?: string
  twitter?: string
  youtube?: string
  whatsapp?: string
  // Enrichment (AI) — rich/variable
  enrichment?: EnrichmentExtra
  enrichmentStatus: EnrichmentStatus
  enrichmentConfidence?: number
  enrichedAt?: string

  // Validation / ICP
  validationStatus?: ValidationStatus
  icpScore?: number
  icpStatus?: string
  icpReason?: string
  scoreBreakdown?: Record<string, number>
  validatedAt?: string

  // Deep research (inline)
  researchStatus: ResearchStatus
  researchSummary?: string
  research?: Record<string, unknown>   // full structured result + sources visited
  researchConfidence?: number
  researchedAt?: string

  // Timestamps
  capturedAt: string
  updatedAt: string
}

export type ScrapedLead = PipelineLead

export interface ImportedLead extends PipelineLead {
  importFile?: string
  sourceRow?: Record<string, string>   // original CSV/Excel row, for audit
}
