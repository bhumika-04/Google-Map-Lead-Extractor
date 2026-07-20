// ── Evidence ranker ───────────────────────────────────────────────────────────
// Ranks Google search evidence before source visits, so the highest-value
// links are opened first. Composite score:
//   1. Exact company-name match      (0–40)  — matchConfidence from tokenizer
//   2. City / country match          (0–15)  — mentioned in title or snippet
//   3. Domain relevance              (0–10)  — local ccTLD (.om for Oman etc.)
//   4. Result type trust             (0–20)  — registry > website > linkedin > …
//   5. Address / phone match         (0–15)  — lead's phone digits in snippet
//   minus a small rank penalty so Google's own ordering breaks ties.

import type { SearchEvidence, DetectedType } from '@/types/searchEvidence'
import { getCountryIntelligence } from '@/config/countryIntelligence'

// Trust weight per source type — mirrors the Company Intelligence page order.
const TYPE_TRUST: Record<DetectedType, number> = {
  official_website:   20,
  corporate_registry: 19,
  google_ai:          15,   // never ranked for visits — synthetic source only
  linkedin:           17,
  company_directory:  13,
  indiamart:          12,
  tradeindia:         12,
  zaubacorp:          12,
  news:               9,
  review_site:        6,
  facebook:           8,
  instagram:          7,
  youtube:            5,
  ambitionbox:        5,
  unknown:            0,
}

export interface LeadRankContext {
  companyName: string
  city: string
  country: string
  phone?: string
  address?: string
}

export function scoreEvidence(e: SearchEvidence, lead: LeadRankContext): number {
  const intel = getCountryIntelligence(lead.country)
  const haystack = `${e.title} ${e.snippet} ${e.displayUrl}`.toLowerCase()

  // 1. Name match (0–40)
  let score = Math.min(1, Math.max(0, e.matchConfidence)) * 40

  // 2. City / country match (0–15)
  const cityHit    = lead.city && haystack.includes(lead.city.toLowerCase())
  const countryHit = haystack.includes(intel.countryName.toLowerCase())
  if (cityHit)         score += 10
  else if (countryHit) score += 5
  if (cityHit && countryHit) score += 5

  // 3. Local domain relevance (0–10)
  if (intel.localDomains.some((tld) => e.sourceDomain.endsWith(tld))) score += 10

  // 4. Type trust (0–20)
  score += TYPE_TRUST[e.detectedType] ?? 0

  // 5. Phone / address match (0–15)
  if (lead.phone) {
    const phoneDigits = lead.phone.replace(/\D/g, '').slice(-7)   // last 7 digits — format-independent
    if (phoneDigits.length >= 7 && haystack.replace(/\D/g, '').includes(phoneDigits)) score += 15
  }
  if (lead.address && score < 100) {
    // Address token overlap — any 2+ address words appearing in the snippet
    const addrTokens = lead.address.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 3)
    const hits = addrTokens.filter((t) => haystack.includes(t)).length
    if (hits >= 2) score += 8
  }

  // Rank penalty — Google's ordering breaks ties
  score -= e.rank * 0.5

  return Math.round(score * 10) / 10
}

/**
 * Scores and sorts evidence, returning the visit list:
 *  - visitable types only (skips review_site / unknown / rejected)
 *  - up to `maxVisits` sources total, at most `maxPerType` per source type
 */
export function rankAndSelect(
  evidence: SearchEvidence[],
  lead: LeadRankContext,
  visitableTypes: readonly DetectedType[],
  opts: { maxVisits?: number; maxPerType?: number; includeRejected?: boolean } = {},
): SearchEvidence[] {
  const { maxVisits = 6, maxPerType = 2, includeRejected = false } = opts

  const scored = evidence
    .filter((e) => (includeRejected || !e.rejected) && visitableTypes.includes(e.detectedType))
    .map((e) => { e.rankScore = scoreEvidence(e, lead); return e })
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))

  const perType = new Map<string, number>()
  const seenPages = new Set<string>()
  const selected: SearchEvidence[] = []
  for (const e of scored) {
    if (selected.length >= maxVisits) break
    const count = perType.get(e.detectedType) ?? 0
    if (count >= maxPerType) continue
    // The same page often appears twice with cosmetic URL differences
    // (tracking query params, trailing slash) — visiting it twice wastes a
    // fetch + an AI extraction call on identical content.
    let pageKey = e.url
    try {
      const u = new URL(e.url)
      pageKey = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase()
    } catch { /* keep raw url as key */ }
    if (seenPages.has(pageKey)) continue
    seenPages.add(pageKey)
    perType.set(e.detectedType, count + 1)
    selected.push(e)
  }
  return selected
}
