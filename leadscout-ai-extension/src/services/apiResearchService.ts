// HTTP client for Phase 3 evidence-based research data.
// MSSQL is the sole source of truth — no IndexedDB for these tables.

import type { SearchEvidence, SourcePage } from '@/types/searchEvidence'
import type { CompanyResearch } from '@/types/searchEvidence'

const API_BASE = 'http://localhost:5150'

interface SearchEvidenceDto {
  query: string; title: string; url: string; displayUrl: string; snippet: string
  rank: number; sourceDomain: string; detectedType: string
  matchConfidence: number; rejected: boolean; rejectReason?: string
}

interface SourcePageDto {
  url: string; sourceDomain: string; sourceType: string; pageTitle?: string
  extractedJson?: string; confidence?: number; status: string; errorMessage?: string
}

interface CompanyResearchDto {
  companyName: string; officialWebsite?: string; linkedinUrl?: string
  facebookUrl?: string; instagramUrl?: string; indiamartUrl?: string
  tradeindiaUrl?: string; ownerName?: string; directors?: string
  productsServices?: string; businessType?: string; teamSize?: string
  turnover?: string; establishedYear?: number; address?: string
  phone?: string; email?: string; confidence: number; sourcesJson?: string
}

interface Phase3SavePayload {
  mssqlCompanyId: string
  evidence: SearchEvidenceDto[]
  sourcePages: SourcePageDto[]
  companyResearch: CompanyResearchDto
}

export async function savePhase3Data(
  mssqlCompanyId: string,
  evidence: SearchEvidence[],
  sourcePages: SourcePage[],
  companyResearch: Omit<CompanyResearch, 'id' | 'leadId' | 'createdAt' | 'updatedAt'>,
): Promise<boolean> {
  const payload: Phase3SavePayload = {
    mssqlCompanyId,
    evidence: evidence.map((e) => ({
      query:          e.query,
      title:          e.title,
      url:            e.url,
      displayUrl:     e.displayUrl,
      snippet:        e.snippet,
      rank:           e.rank,
      sourceDomain:   e.sourceDomain,
      detectedType:   e.detectedType,
      matchConfidence: e.matchConfidence,
      rejected:       e.rejected,
      rejectReason:   e.rejectReason,
    })),
    sourcePages: sourcePages.map((p) => ({
      url:          p.url,
      sourceDomain: p.sourceDomain,
      sourceType:   p.sourceType,
      pageTitle:    p.pageTitle,
      extractedJson: p.extractedJson,
      confidence:   p.confidence,
      status:       p.status,
      errorMessage: p.errorMessage,
    })),
    companyResearch: {
      companyName:      companyResearch.companyName,
      officialWebsite:  companyResearch.officialWebsite,
      linkedinUrl:      companyResearch.linkedinUrl,
      facebookUrl:      companyResearch.facebookUrl,
      instagramUrl:     companyResearch.instagramUrl,
      indiamartUrl:     companyResearch.indiamartUrl,
      tradeindiaUrl:    companyResearch.tradeindiaUrl,
      ownerName:        companyResearch.ownerName,
      directors:        companyResearch.directors,
      productsServices: companyResearch.productsServices,
      businessType:     companyResearch.businessType,
      teamSize:         companyResearch.teamSize,
      turnover:         companyResearch.turnover,
      establishedYear:  companyResearch.establishedYear,
      address:          companyResearch.address,
      phone:            companyResearch.phone,
      email:            companyResearch.email,
      confidence:       companyResearch.confidence,
      sourcesJson:      companyResearch.sourcesJson,
    },
  }

  try {
    const res = await fetch(`${API_BASE}/api/phase3/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── GET: list all companies with company_research rows ────────────────────────

export interface ApiCompanyResearch {
  mssqlId: string
  companyName: string
  city?: string
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
  sourcesJson?: string
  updatedAt: string
  evidenceCount?: number
  sourcePagesCount?: number
}

export interface ApiSearchEvidence {
  id: string; query: string; title: string; url: string; displayUrl: string
  snippet: string; rank: number; sourceDomain: string; detectedType: string
  matchConfidence: number; rejected: boolean; rejectReason?: string; capturedAt: string
}

export interface ApiSourcePage {
  id: string; url: string; sourceDomain: string; sourceType: string
  pageTitle?: string; extractedJson?: string; confidence?: number
  status: string; errorMessage?: string; capturedAt: string
}

export interface ApiCompanyResearchDetail extends ApiCompanyResearch {
  evidence: ApiSearchEvidence[]
  sourcePages: ApiSourcePage[]
}

export async function fetchPhase3Companies(): Promise<ApiCompanyResearch[]> {
  try {
    const res = await fetch(`${API_BASE}/api/phase3/companies`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json()
    return data.companies ?? []
  } catch {
    return []
  }
}

export async function fetchPhase3CompanyDetail(mssqlId: string): Promise<ApiCompanyResearchDetail | null> {
  try {
    const res = await fetch(`${API_BASE}/api/phase3/company/${mssqlId}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = await res.json()
    return { ...data.research, evidence: data.evidence ?? [], sourcePages: data.sourcePages ?? [] }
  } catch {
    return null
  }
}
