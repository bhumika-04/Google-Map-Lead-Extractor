// Merges per-source-page AI extractions into one CompanyResearch row (for the
// new Company Intelligence UI) and maps the same merge into the legacy
// ResearchResult shape so existing consumers (ResearchPage, CSV export, SQL
// sync, ValidationPanel, LeadDetailPanel) keep working unchanged.

import type { SourcePage, CompanyResearch } from '@/types/searchEvidence'
import type { ResearchResult } from '@/types/research'
import { buildResearchResult } from './claudeResearch'
import type { IcpFit } from './evidenceExtractor'

interface ExtractedData {
  decisionMaker?: string
  decisionMakerLinkedIn?: string
  email?: string
  alternatePhone?: string
  website?: string
  linkedIn?: string
  facebook?: string
  instagram?: string
  twitter?: string
  youtube?: string
  whatsapp?: string
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
  teamMembers?: { name: string; role: string }[]
  painPoints?: string[]
  expansionSignals?: string[]
  currentSoftware?: string[]
  supplierBuyerType?: 'manufacturer' | 'trader' | 'distributor' | 'service_provider' | 'mixed'
  exportMarkets?: string[]
  icpFit?: IcpFit
  confidence: number
}

const SCALAR_FIELDS: (keyof ExtractedData)[] = [
  'decisionMaker', 'decisionMakerLinkedIn', 'email', 'alternatePhone', 'website', 'linkedIn',
  'facebook', 'instagram', 'twitter', 'youtube', 'whatsapp', 'summary', 'tagline',
  'employeeCount', 'annualTurnover', 'yearFounded', 'companyType', 'industry', 'headquarters',
  'supplierBuyerType',
]

const ARRAY_FIELDS: (keyof ExtractedData)[] = [
  'services', 'certifications', 'majorClients', 'teamMembers', 'painPoints', 'expansionSignals',
  'currentSoftware', 'exportMarkets',
]

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === 'null' || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return false
}

export interface MergeResult {
  merged: ExtractedData
  fieldSources: Record<string, string> // field name -> sourcePage.url that won
}

// Picks, for each field, the value from the highest-confidence source page
// that actually populated it — array fields are unioned across all pages.
export function mergeSourcePages(sourcePages: SourcePage[]): MergeResult {
  const extracted = sourcePages
    .filter((p) => p.status === 'extracted' && p.extractedJson)
    .map((p) => ({ page: p, data: JSON.parse(p.extractedJson!) as ExtractedData }))
    .sort((a, b) => (b.data.confidence ?? 0) - (a.data.confidence ?? 0))

  const merged: ExtractedData = { confidence: 0 }
  const fieldSources: Record<string, string> = {}

  for (const field of SCALAR_FIELDS) {
    for (const { page, data } of extracted) {
      const v = data[field]
      if (!isEmpty(v)) {
        ;(merged as any)[field] = v
        fieldSources[field] = page.url
        break
      }
    }
  }

  for (const field of ARRAY_FIELDS) {
    const union = new Map<string, any>()
    let winnerUrl: string | undefined
    for (const { page, data } of extracted) {
      const v = data[field] as any[] | undefined
      if (!v || v.length === 0) continue
      if (!winnerUrl) winnerUrl = page.url
      for (const item of v) {
        const key = typeof item === 'string' ? item : JSON.stringify(item)
        if (!union.has(key)) union.set(key, item)
      }
    }
    if (union.size > 0) {
      ;(merged as any)[field] = [...union.values()]
      if (winnerUrl) fieldSources[field] = winnerUrl
    }
  }

  merged.confidence = extracted.length
    ? extracted.reduce((sum, e) => sum + (e.data.confidence ?? 0), 0) / extracted.length
    : 0

  // Pick the icpFit with the highest confidence across all pages
  const bestFit = extracted
    .map((e) => e.data.icpFit)
    .filter(Boolean)
    .sort((a, b) => (b!.confidence ?? 0) - (a!.confidence ?? 0))[0]
  if (bestFit) merged.icpFit = bestFit

  return { merged, fieldSources }
}

export function aggregateCompanyResearch(
  leadId: number,
  companyName: string,
  sourcePages: SourcePage[],
): Omit<CompanyResearch, 'id' | 'createdAt' | 'updatedAt'> {
  const { merged, fieldSources } = mergeSourcePages(sourcePages)

  const byType = (type: SourcePage['sourceType']) =>
    sourcePages.find((p) => p.sourceType === type && p.status !== 'failed')?.url

  return {
    leadId,
    companyName,
    officialWebsite: byType('official_website') ?? merged.website,
    linkedinUrl:     byType('linkedin') ?? merged.linkedIn,
    facebookUrl:     byType('facebook') ?? merged.facebook,
    instagramUrl:    byType('instagram') ?? merged.instagram,
    indiamartUrl:    byType('indiamart'),
    tradeindiaUrl:   byType('tradeindia'),
    ownerName:       merged.decisionMaker,
    directors:       merged.teamMembers?.map((m) => `${m.name} (${m.role})`).join('; '),
    productsServices: merged.services?.join(', '),
    businessType:    merged.companyType,
    teamSize:        merged.employeeCount,
    turnover:        merged.annualTurnover,
    establishedYear: merged.yearFounded,
    address:         merged.headquarters,
    phone:           merged.alternatePhone,
    email:           merged.email,
    confidence:      merged.confidence,
    sourcesJson:     JSON.stringify(fieldSources),
  }
}

export function mapToLegacyResearchResult(
  merged: ExtractedData,
  leadId: number,
  jobId: number,
  sourceUrl: string | undefined,
  sources: { label: string; url: string }[],
): Omit<ResearchResult, 'id' | 'createdAt'> {
  // claudeResearch's buildResearchResult doesn't handle Gemini-only fields
  // (decisionMakerLinkedIn, supplierBuyerType, exportMarkets) — overlay them.
  const result = buildResearchResult(leadId, jobId, merged as any, sourceUrl)
  return {
    ...result,
    sources,
    decisionMakerLinkedIn: merged.decisionMakerLinkedIn ?? result.decisionMakerLinkedIn,
    supplierBuyerType:     merged.supplierBuyerType     ?? result.supplierBuyerType,
    exportMarkets:         merged.exportMarkets?.length  ? merged.exportMarkets : result.exportMarkets,
  }
}
