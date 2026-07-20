// Scrapes Google search results for a company to extract real financial data.
//
// Opens ONE background tab per company (sequentially, with controlled delays).
// Searches Google for "[CompanyName] [City] annual turnover" and reads the
// AI Overview card / Knowledge Panel / featured snippet that Google renders —
// which aggregates MCA / Tofler / IndiaMART / company website data.
//
// No API key needed. One tab at a time. Tab is closed before the next opens.

import { runInTab } from './socialScraper'
import { getCountryIntelligence } from '@/config/countryIntelligence'
import { isGoogleEvidenceBlocked, googleSearchCooldownRemaining, noteGoogleSearch } from './googleEvidenceService'

// Tab load is allowed up to 30s; AFTER load, the injected function waits up
// to 45s more for the AI Mode answer to finish streaming (see the stability
// loop below) — AI answers generate progressively over 10–40s.
const GOOGLE_TAB_TIMEOUT_MS = 30000

// ── Injected function — executes inside the Google search tab ─────────────────
// MUST be fully self-contained: no imports, no closure captures.
// Chrome serialises this function body and re-evaluates it in the tab's JS context.

async function _extractGoogleCompanyCard(): Promise<{ fields: Record<string, string>; urls: string[]; answerText: string } | null> {
  // If Google returned an error page or CAPTCHA, bail out immediately
  const title = document.title?.toLowerCase() ?? ''
  if (title.includes('error') || title.includes('404') || title.includes('captcha')) {
    return null
  }

  // Wait for the AI answer to FINISH streaming. Keyword-polling is unusable
  // here: the page echoes our own query ("…annual turnover employees
  // directors…") at the top, so any keyword check matches instantly while the
  // answer is still on its "Searching…" placeholder — the scraper then read
  // an empty page every single time. Instead, wait until the page text stops
  // growing (stable for ~4s at a meaningful size) or the 45s deadline hits.
  // AI Mode typically streams its answer over 10–40s; a classic results page
  // is fully rendered already and passes the stability check within seconds.
  const deadline = Date.now() + 45000
  let lastLen = -1
  let stableCount = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
    const len = (document.body?.innerText ?? '').length
    if (len === lastLen && len > 900) {
      stableCount++
      if (stableCount >= 3) break   // no growth across ~3.6s — answer finished
    } else {
      stableCount = 0
      lastLen = len
    }
  }

  const bodyText = document.body?.innerText ?? ''
  if (bodyText.length < 400) return null

  const lines = bodyText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const result: Record<string, string> = {}

  // Returns the value on the line immediately after a line matching any keyword.
  function nextValue(keywords: string[]): string | undefined {
    for (let i = 0; i < lines.length - 1; i++) {
      const lower = lines[i].toLowerCase()
      if (keywords.some((k) => lower.includes(k))) {
        const val = lines[i + 1]
        if (
          val &&
          val.length > 0 &&
          val.length < 300 &&
          !val.toLowerCase().includes('see more') &&
          !val.toLowerCase().includes('feedback') &&
          !val.toLowerCase().includes('google')
        ) {
          return val.trim()
        }
      }
    }
    return undefined
  }

  // ── Annual Turnover ──────────────────────────────────────────────────────────
  const turnover = nextValue([
    'estimated annual turnover',
    'annual turnover',
    'yearly turnover',
    'annual revenue',
  ])
  // Only accept if it looks like a monetary value (₹, Cr, Lakh, L, crore)
  if (turnover && /[₹\d]/.test(turnover) &&
      /cr|lakh|crore|lac|l\b|\d/i.test(turnover)) {
    result.annualTurnover = turnover
  }

  // ── Employee count ───────────────────────────────────────────────────────────
  const empRaw = nextValue([
    'number of employees',
    'employees',
    'staff strength',
    'team size',
    'total employees',
  ])
  if (empRaw) {
    // Accept numbers, ranges, or words like "50-200" or "45 employees"
    const numMatch = empRaw.match(/\d[\d,\s\-–to]+\d|\d+/)
    if (numMatch) result.employeeCount = numMatch[0].trim()
  }

  // ── CIN (Corporate Identification Number) ───────────────────────────────────
  const cinLabel = nextValue([
    'corporate identification number',
    '\bcin\b',
    'cin number',
  ])
  if (cinLabel) {
    const m = cinLabel.match(/[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}/)
    if (m) result.cin = m[0]
  }
  // Also scan all lines for bare CIN pattern (sometimes not adjacent to a label)
  if (!result.cin) {
    for (const line of lines) {
      const m = line.match(/\b([A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/)
      if (m) { result.cin = m[1]; break }
    }
  }

  // ── Directors / Decision Makers ──────────────────────────────────────────────
  const directors = nextValue([
    'directors',
    'key people',
    'management team',
    'founder',
    'owner',
    'proprietor',
  ])
  if (directors && directors.length < 250 && !directors.match(/^\d/)) {
    result.directors = directors
  }

  // ── Registered Address ───────────────────────────────────────────────────────
  const addr = nextValue([
    'registered office address',
    'registered address',
    'office address',
    'principal place',
  ])
  if (addr && addr.length < 300) result.address = addr

  // ── Authorized / Paid-up Capital ─────────────────────────────────────────────
  const capital = nextValue([
    'authorized & paid-up capital',
    'authorized capital',
    'paid-up capital',
    'authorised capital',
  ])
  if (capital) result.capital = capital

  // ── Company Type ─────────────────────────────────────────────────────────────
  const fullText = bodyText
  if (/private limited|pvt\.?\s*ltd/i.test(fullText))    result.companyType = 'Pvt Ltd'
  else if (/ llp\b/i.test(fullText))                      result.companyType = 'LLP'
  else if (/public limited/i.test(fullText))               result.companyType = 'Public Ltd'
  else if (/proprietorship|proprietor/i.test(fullText))   result.companyType = 'Proprietorship'
  else if (/partnership/i.test(fullText))                  result.companyType = 'Partnership'

  // ── First useful summary sentence ─────────────────────────────────────────────
  for (const line of lines) {
    if (
      line.length > 80 &&
      line.length < 400 &&
      !line.startsWith('http') &&
      !line.match(/^\d{1,2}[\/.]\d{1,2}/) &&
      !line.includes('©') &&
      !line.toLowerCase().includes('google') &&
      !line.toLowerCase().includes('search') &&
      !line.toLowerCase().includes('feedback') &&
      !line.toLowerCase().includes('cookie')
    ) {
      result.summary = line
      break
    }
  }

  // ── Cited / result URLs (non-Google), in page order ─────────────────────────
  // In AI Mode these are the answer's citations; on a normal SERP they're the
  // organic results. Either way they're Google's chosen sources for THIS
  // company — the research pipeline visits each one and extracts from it.
  const urls: string[] = []
  const seenUrls = new Set<string>()
  for (const a of Array.from(document.querySelectorAll('a[href^="http"]'))) {
    const href = ((a as HTMLAnchorElement).href ?? '').split('#')[0]
    if (!href) continue
    let host = ''
    try { host = new URL(href).hostname } catch { continue }
    if (/(^|\.)google\.[a-z]{2,6}(\.[a-z]{2})?$/.test(host)) continue
    if (/gstatic\.com|googleusercontent\.com|googleadservices|doubleclick|googletagmanager/.test(host)) continue
    if (seenUrls.has(href)) continue
    seenUrls.add(href)
    urls.push(href)
    if (urls.length >= 12) break
  }

  if (Object.keys(result).length === 0 && urls.length === 0) return null

  // The raw answer/page text — the AI extractor pulls prose-form claims
  // (turnover, team size, key people) that the label/value heuristics miss.
  return { fields: result, urls, answerText: bodyText.slice(0, 6000) }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface GoogleAiCompanyData {
  annualTurnover?:  string
  employeeCount?:   string
  cin?:             string
  directors?:       string
  address?:         string
  capital?:         string
  companyType?:     string
  summary?:         string
}

export interface GoogleAiValidation {
  /** Deterministic label/value hits from the AI Overview / Knowledge Panel */
  fields: GoogleAiCompanyData
  /** URLs the AI answer cites (or organic results on fallback) — visit candidates */
  urls: string[]
  /** Raw answer/page text for AI-based extraction of prose-form claims */
  answerText: string
  /** The AI Mode search URL — used as the sourceUrl for attribution */
  searchUrl: string
}

// Runs one Google AI Mode search for the lead and returns everything found.
// Asks for the same fields the OpenAI enrichment prompt covers (turnover,
// employee count, directors/founders, industry, company type, year founded)
// so the research pipeline can VALIDATE the lead's estimated values against
// what Google actually surfaces. Shares the global Google pacing/cooldown
// with the evidence search — this is one more Google request per lead.
export async function scrapeGoogleAiCompany(
  companyName: string,
  city: string,
  country = 'IN',
): Promise<GoogleAiValidation | null> {
  if (isGoogleEvidenceBlocked()) {
    console.log(`[googleAiScraper] 🚫 Google in cooldown — skipping AI-mode search for "${companyName}"`)
    return null
  }
  const wait = googleSearchCooldownRemaining()
  if (wait > 0) {
    console.log(`[googleAiScraper] ⏳ Waiting ${(wait / 1000).toFixed(1)}s before AI-mode search (rate limit)`)
    await new Promise((r) => setTimeout(r, wait))
  }
  noteGoogleSearch()

  const intel = getCountryIntelligence(country)
  // Mirrors the OpenAI enrichment prompt's fields, phrased as a search question
  const query = `"${companyName}" ${city} ${intel.countryName} company annual turnover employees directors founders industry company type year founded`
  // udm=50 = Google AI Mode. Where AI Mode is unavailable, Google serves a
  // normal results page — the extractor reads either layout the same way.
  const searchUrl = `https://www.google.com/search?udm=50&hl=en&gl=${intel.googleRegion}&q=${encodeURIComponent(query)}`

  try {
    const raw = await runInTab<{ fields: Record<string, string>; urls: string[]; answerText: string } | null>(
      searchUrl,
      _extractGoogleCompanyCard,
      [],
      GOOGLE_TAB_TIMEOUT_MS,
    )
    if (!raw) return null
    return {
      fields: raw.fields as GoogleAiCompanyData,
      urls: raw.urls ?? [],
      answerText: raw.answerText ?? '',
      searchUrl,
    }
  } catch (err) {
    console.warn(`[googleAiScraper] "${companyName}": ${err}`)
    return null
  }
}
