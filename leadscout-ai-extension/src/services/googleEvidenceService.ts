// Captures every Google search result as discrete SearchEvidence rows — title,
// url, displayUrl, snippet, rank — rather than collapsing the whole page into
// one text blob. Each result is then classified by link type and scored
// against the lead's company name so mismatched-company evidence can be
// rejected (with a reason) instead of silently feeding the extraction step.
//
// International pipeline: uses the country intelligence layer for the Google
// domain / region, runs a local-language fallback search when the English
// query returns too little, and a LinkedIn site: discovery search when no
// LinkedIn evidence surfaced organically.

import { fetchRenderedHtml } from './socialScraper'
import { classifyUrl, matchesCompany, matchesCompanyTitle, MATCH_THRESHOLD } from './linkClassifier'
import { getCountryIntelligence } from '@/config/countryIntelligence'
import { generateEvidenceQueries } from './queryLocalizer'
import type { SearchEvidence } from '@/types/searchEvidence'
import { nowISO } from '@/utils/date'

const FETCH_TIMEOUT_MS = 25000

// Gap between the sub-searches of ONE lead (primary → local-language → site:)
// — shorter than the inter-lead gap but still human-ish.
const INTRA_LEAD_SEARCH_GAP_MS = () => 15000 + Math.random() * 10000

// Cleans a raw Google Maps company name into a concise search query term.
// Maps names often contain hashtags, parenthetical descriptions, Arabic/Urdu
// suffixes, and emoji that make quoted Google queries return zero results.
function buildSearchName(name: string): string {
  // 1. For mixed Latin+non-Latin names (e.g. "Qertas Printing قرطاس"),
  //    use only the Latin portion — Arabic inside a quoted query kills results.
  const latinOnly = name.replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim()
  if (latinOnly.length >= 4 && latinOnly.length < name.length) {
    // Has meaningful Latin text alongside non-Latin — prefer Latin for search
    return buildSearchName(latinOnly)
  }

  let s = name
    // Remove hashtag sequences (#sticker #banner etc.)
    .replace(/#\S+/g, '')
    // Remove long parenthetical descriptions (10+ chars inside parens)
    .replace(/\s*\([^)]{10,}\)/g, '')
    // Remove emoji
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

  // If still very long (>50 chars), take only the segment before - | : separator
  if (s.length > 50) {
    const segment = s.match(/^([^|\-–:]+)/)
    if (segment && segment[1].trim().length >= 4) s = segment[1].trim()
  }

  return s.slice(0, 60).trim() || name.slice(0, 60)
}

// Google's bot-detection interstitial — same check used in websiteFetcher.ts,
// plus the /sorry/ redirect page and the EU consent interstitial.
function isGoogleBlocked(html: string | null): boolean {
  if (!html) return false
  return (
    /unusual traffic|detected unusual traffic|systems have detected|recaptcha/i.test(html) && html.length < 20000
  ) || /google\.[a-z.]+\/sorry\/|consent\.google\.[a-z.]+/i.test(html.slice(0, 4000))
}

let googleBlockedUntil = 0
const GOOGLE_BLOCK_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes — Google SERP blocks last longer than 5 min

// Minimum gap between consecutive Google searches — prevents triggering bot detection
// when the research alarm runs back-to-back jobs.
let lastGoogleSearchAt = 0
const MIN_SEARCH_GAP_MS = 45 * 1000 // 45 seconds between searches

export function googleSearchCooldownRemaining(): number {
  const sinceLastSearch = Date.now() - lastGoogleSearchAt
  return Math.max(0, MIN_SEARCH_GAP_MS - sinceLastSearch)
}

export function isGoogleEvidenceBlocked(): boolean {
  return Date.now() < googleBlockedUntil
}

// Lets other Google-touching services (the AI-mode validation search) count
// their request against the same global 45s pacing gap as evidence searches.
export function noteGoogleSearch(): void {
  lastGoogleSearchAt = Date.now()
}

function decodeGoogleUrl(raw: string): string {
  const m = raw.match(/[?&]q=(https?[^&"]+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return raw
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NON_RESULT_DOMAIN_FRAGMENTS = [
  'googleapis.com', 'googleusercontent.com', 'gstatic.com',
  'accounts.google', 'support.google', 'policies.google', 'webcache.googleusercontent',
]
// Any hostname that IS a Google domain (any subdomain, any TLD) is not a result
function isGoogleOwnDomain(hostname: string): boolean {
  return /^([a-z0-9-]+\.)*google\.[a-z]{2,6}(\.[a-z]{2})?$/.test(hostname)
}

interface RawGoogleResult {
  title: string
  url: string
  displayUrl: string
  snippet: string
}

// Parses Google's rendered search results page into discrete result rows.
// Heuristic/regex-based (no DOMParser available in the MV3 service worker
// context) — finds each <a href>…<h3>title</h3> organic-result anchor, then
// captures the chunk of markup up to the next anchor as that result's snippet.
export function extractGoogleResultList(html: string): RawGoogleResult[] {
  const anchorRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>((?:(?!<\/a>)[\s\S])*?)<h3[^>]*>([\s\S]*?)<\/h3>/gi
  const matches: { url: string; title: string; index: number; end: number }[] = []
  let m: RegExpExecArray | null

  while ((m = anchorRe.exec(html)) !== null) {
    const url = decodeGoogleUrl(m[1]).split('?utm_')[0]
    const title = stripTags(m[3])
    if (!title) continue
    let hostname = ''
    try { hostname = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
    if (isGoogleOwnDomain(hostname) || NON_RESULT_DOMAIN_FRAGMENTS.some((d) => hostname.includes(d))) continue

    matches.push({ url, title, index: m.index, end: anchorRe.lastIndex })
  }

  const results: RawGoogleResult[] = []
  const seen = new Set<string>()

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    if (seen.has(cur.url)) continue
    seen.add(cur.url)

    const next = matches[i + 1]
    const chunkEnd = next ? next.index : Math.min(cur.end + 2000, html.length)
    const chunk = html.slice(cur.end, chunkEnd)

    const citeMatch = chunk.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)
    const displayUrl = citeMatch ? stripTags(citeMatch[1]) : cur.url

    const snippet = stripTags(chunk).slice(0, 400)

    results.push({ title: cur.title, url: cur.url, displayUrl, snippet })
  }

  return results.slice(0, 20)
}

// ── Single search execution ───────────────────────────────────────────────────

interface SearchContext {
  leadId: number
  sessionId: number
  companyName: string
  googleDomain: string
  gl: string
}

/** Runs one Google search and converts the SERP into SearchEvidence rows. */
async function executeSearch(
  ctx: SearchContext,
  query: string,
  queryLanguage: string,
): Promise<SearchEvidence[] | null> {
  lastGoogleSearchAt = Date.now()
  const hl = queryLanguage === 'en' ? 'en' : queryLanguage
  const searchUrl = `https://www.${ctx.googleDomain}/search?num=20&hl=${hl}&gl=${ctx.gl}&q=${encodeURIComponent(query)}`
  console.log(`[google-evidence] 🔍 [${queryLanguage}] Searching on ${ctx.googleDomain}: ${query}`)

  const html = await fetchRenderedHtml(searchUrl, FETCH_TIMEOUT_MS)
  console.log(`[google-evidence] 📄 Got HTML: ${html ? `${html.length} chars` : 'null/empty'}`)

  if (isGoogleBlocked(html)) {
    googleBlockedUntil = Date.now() + GOOGLE_BLOCK_COOLDOWN_MS
    console.warn(`[google-evidence] 🚫 Google blocked (reCAPTCHA detected) — cooldown: ${GOOGLE_BLOCK_COOLDOWN_MS / 60000} min`)
    return null   // null = blocked, caller must stop searching
  }
  if (!html) {
    console.warn(`[google-evidence] ⚠️ Empty HTML for query "${query}"`)
    return []
  }

  // When a quoted query matches nothing, Google silently substitutes an
  // unquoted "Results for X (without quotes):" list — those are NOT matches
  // for our query and must not be parsed as evidence (e.g. a site:linkedin.com
  // "Exact Company Name" search with zero hits falls back to unrelated pages
  // like a totally different company's LinkedIn post).
  if (/no results found for/i.test(html)) {
    console.log(`[google-evidence] ∅ No results for query "${query}" — skipping (not using unquoted fallback)`)
    return []
  }

  const raw = extractGoogleResultList(html)
  console.log(`[google-evidence] 📋 [${queryLanguage}] Parsed ${raw.length} raw results`)

  // Soft-block detection: a real results page practically always contains
  // parseable organic results or an explicit "did not match any documents"
  // message. Zero parsed results WITHOUT that marker means Google served a
  // challenge/consent/degraded shell the hard reCAPTCHA check above didn't
  // recognize (or changed its result DOM). Without this, every job during a
  // block "finds no evidence" and permanently fails in bulk — even companies
  // like SRF or DuPont that obviously have results. Treat it as blocked so
  // the caller requeues jobs and retries after the cooldown.
  // (English queries only — the "did not match" marker is localized, so a
  // genuinely-empty Arabic/Turkish fallback SERP must not false-flag a block.)
  if (raw.length === 0 && queryLanguage === 'en' && !/did not match any documents/i.test(html)) {
    googleBlockedUntil = Date.now() + GOOGLE_BLOCK_COOLDOWN_MS
    console.warn(`[google-evidence] 🚫 0 results parsed with no "no results" marker — treating as soft block, cooldown ${GOOGLE_BLOCK_COOLDOWN_MS / 60000} min`)
    return null   // null = blocked, caller must stop searching
  }

  const capturedAt = nowISO()

  return raw.map((r, i) => {
    const detectedType = classifyUrl(r.url)
    const matchConfidence = matchesCompany(r.title, r.snippet, ctx.companyName)
    const rejected = matchConfidence < MATCH_THRESHOLD
    const sourceDomain = (() => {
      try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' }
    })()

    return {
      leadId: ctx.leadId,
      sessionId: ctx.sessionId,
      query,
      queryLanguage,
      title: r.title,
      url: r.url,
      displayUrl: r.displayUrl,
      snippet: r.snippet,
      rank: i + 1,
      sourceDomain,
      detectedType,
      matchConfidence,
      rejected,
      rejectReason: rejected
        ? `Name mismatch: evidence title/snippet doesn't match "${ctx.companyName}" (score ${matchConfidence.toFixed(2)})`
        : undefined,
      capturedAt,
    } as SearchEvidence
  })
}

// ── Orchestrated evidence collection for one lead ─────────────────────────────
// 1. Primary English query on the country's Google domain
// 2. Local-language fallback (Arabic/Urdu name) when primary yields < 3 accepted
// 3. LinkedIn site: discovery when no LinkedIn evidence surfaced organically

export async function runGoogleSearchEvidence(
  leadId: number,
  sessionId: number,
  companyName: string,
  city: string,
  country = 'IN',
  opts?: { skipLinkedInDiscovery?: boolean },
): Promise<SearchEvidence[]> {
  if (isGoogleEvidenceBlocked()) {
    console.warn(`[google-evidence] 🚫 Still in cooldown — skipping search for "${companyName}"`)
    return []
  }

  const wait = googleSearchCooldownRemaining()
  if (wait > 0) {
    console.log(`[google-evidence] ⏳ Waiting ${(wait / 1000).toFixed(1)}s before next search (rate limit)`)
    await new Promise((r) => setTimeout(r, wait))
  }

  const intel = getCountryIntelligence(country)
  const ctx: SearchContext = {
    leadId, sessionId, companyName,
    googleDomain: intel.googleDomain,
    gl: intel.googleRegion,
  }

  // Clean the company name for search — Google Maps names sometimes contain
  // hashtags (#sticker #banner), parenthetical descriptions, and emoji that
  // make the quoted query too specific to return any results.
  const searchName = buildSearchName(companyName)
  if (searchName !== companyName) {
    console.log(`[google-evidence] 🔤 Name cleaned for search: "${companyName}" → "${searchName}"`)
  }

  const { primary, fallback } = generateEvidenceQueries(searchName, companyName, city, country)

  const all: SearchEvidence[] = []
  const seenUrls = new Set<string>()
  const merge = (rows: SearchEvidence[]) => {
    for (const r of rows) {
      if (seenUrls.has(r.url)) continue
      seenUrls.add(r.url)
      all.push(r)
    }
  }

  // 1. Primary English search
  const primaryRows = await executeSearch(ctx, primary.query, primary.language)
  if (primaryRows === null) return []   // blocked
  merge(primaryRows)

  // 2. Local-language fallback — only when the English search found little
  const acceptedCount = all.filter((e) => !e.rejected).length
  if (fallback && acceptedCount < 3) {
    console.log(`[google-evidence] 🌍 Only ${acceptedCount} accepted results — running ${fallback.language} fallback search`)
    await new Promise((r) => setTimeout(r, INTRA_LEAD_SEARCH_GAP_MS()))
    const fallbackRows = await executeSearch(ctx, fallback.query, fallback.language)
    if (fallbackRows === null) return all
    merge(fallbackRows)
  }

  // 3. LinkedIn site: discovery — only when nothing LinkedIn surfaced organically.
  // No exact-phrase quotes: LinkedIn's Google index is sparse, and quoting a
  // multi-word company name (e.g. "Rajdhani offset printers") almost always
  // returns zero results — Google then silently substitutes an unrelated
  // unquoted fallback list, which is worse than no query at all. An unquoted
  // query scoped to site:linkedin.com/company biases toward actual company
  // pages (not random employee profiles or posts mentioning the name).
  const hasLinkedIn = all.some((e) => e.detectedType === 'linkedin' && !e.rejected)
  if (!hasLinkedIn && !opts?.skipLinkedInDiscovery) {
    console.log(`[google-evidence] 🔗 No LinkedIn evidence yet — running site:linkedin.com/company discovery`)
    await new Promise((r) => setTimeout(r, INTRA_LEAD_SEARCH_GAP_MS()))
    const liQuery = `site:linkedin.com/company ${searchName}`
    const liRows = await executeSearch(ctx, liQuery, 'en')
    if (liRows !== null) {
      // Re-score /company/ candidates against the TITLE only — the snippet can
      // mention the target company in an unrelated context (a sister brand's
      // page whose snippet name-drops the parent company), which would
      // otherwise score a false-positive match for the wrong LinkedIn page.
      // Require near-full title overlap (>=0.8) since a generic 1-2 word
      // overlap (e.g. just "Sterling" or "Agro") is not enough to disambiguate
      // between similarly-named but different companies.
      for (const r of liRows) {
        const isCompanyPage = /linkedin\.com\/company\//i.test(r.url)
        if (!isCompanyPage) continue
        const titleScore = matchesCompanyTitle(r.title, ctx.companyName)
        r.matchConfidence = titleScore
        r.rejected = titleScore < 0.8
        r.rejectReason = r.rejected
          ? `LinkedIn title "${r.title}" doesn't sufficiently match "${ctx.companyName}" (title score ${titleScore.toFixed(2)})`
          : undefined
      }
      merge(liRows)
    }
  }

  console.log(`[google-evidence] 🏁 Evidence collection done: ${all.length} unique results (${all.filter(e => !e.rejected).length} accepted)`)

  // Return in-memory only — MSSQL save happens in batch at end of researchService.processNextJob
  return all
}
