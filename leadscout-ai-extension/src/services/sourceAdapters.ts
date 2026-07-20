// ── Source adapters ───────────────────────────────────────────────────────────
// One adapter per source family instead of a single generic scraper. Each
// adapter knows how to fetch its source type, and detects when a source
// blocks access. Blocked sources report a structured reason
// (login_required | forbidden | captcha | robots | not_found | unsupported)
// and the pipeline moves on — restrictions are respected, never bypassed.

import { fetchRenderedHtml } from './socialScraper'
import { fetchWebsiteText, stripHtml } from './websiteFetcher'
import type { DetectedType, BlockedReason } from '@/types/searchEvidence'

const PAGE_TEXT_LENGTH = 4000
const FETCH_TIMEOUT_MS = 25000

export interface AdapterResult {
  ok: boolean
  pageTitle?: string
  rawText?: string
  /** ISO 639-1 code of the dominant script/language in the text */
  detectedLanguage?: string
  blockedReason?: BlockedReason
  errorMessage?: string
  pagesVisited?: number
}

export interface SourceAdapter {
  name: string
  /** True when this adapter handles the given source type */
  canHandle(type: DetectedType): boolean
  /** Whether the source usually needs a logged-in session for full data */
  requiresLogin: boolean
  extract(url: string): Promise<AdapterResult>
}

// ── Language detection (script-based heuristic — no API call) ─────────────────

export function detectLanguage(text: string): string {
  if (!text) return 'en'
  let arabic = 0, devanagari = 0, cjk = 0, latin = 0, bengali = 0
  const sample = text.slice(0, 2000)
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c >= 0x0600 && c <= 0x06FF) arabic++
    else if (c >= 0x0900 && c <= 0x097F) devanagari++
    else if (c >= 0x0980 && c <= 0x09FF) bengali++
    else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF)) cjk++
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++
  }
  const max = Math.max(arabic, devanagari, cjk, latin, bengali)
  if (max === 0) return 'en'
  if (max === arabic)     return 'ar'
  if (max === devanagari) return 'hi'
  if (max === bengali)    return 'bn'
  if (max === cjk)        return 'zh'
  return 'en'
}

// ── Blocked-page detection ────────────────────────────────────────────────────

function detectBlocked(html: string, url: string): BlockedReason | null {
  const h = html.toLowerCase()
  const path = url.toLowerCase()

  // LinkedIn authwall / login redirect
  if (path.includes('linkedin.com') &&
      (path.includes('/authwall') || path.includes('/login') || path.includes('/checkpoint') ||
       h.includes('join linkedin') && h.includes('sign in') && html.length < 30000)) {
    return 'login_required'
  }
  // Facebook / Instagram login walls
  if ((path.includes('facebook.com') || path.includes('instagram.com')) &&
      (h.includes('log in to continue') || h.includes('you must log in') ||
       (h.includes('log in') && h.includes('sign up') && html.length < 40000))) {
    return 'login_required'
  }
  // Cloudflare / generic captcha challenge
  if ((h.includes('cf-challenge') || h.includes('just a moment') || h.includes('checking your browser') ||
       h.includes('recaptcha') || h.includes('hcaptcha')) && html.length < 25000) {
    return 'captcha'
  }
  // Access denied / 403 pages
  if ((h.includes('access denied') || h.includes('403 forbidden')) && html.length < 20000) {
    return 'forbidden'
  }
  // 404 pages — common patterns on aggregators (ZoomInfo, RocketReach)
  if ((h.includes('404') && (h.includes('not found') || h.includes("can't seem to find") ||
       h.includes('page you are looking for') || h.includes('houston, we have a problem'))) &&
      html.length < 60000) {
    return 'not_found'
  }
  return null
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
}

// ── Shared tab-render fetch with blocked detection ────────────────────────────

async function renderedFetch(url: string): Promise<AdapterResult> {
  const html = await fetchRenderedHtml(url, FETCH_TIMEOUT_MS)
  if (!html) return { ok: false, errorMessage: 'Failed to load page' }

  const blocked = detectBlocked(html, url)
  if (blocked) return { ok: false, blockedReason: blocked }

  const rawText = stripHtml(html, PAGE_TEXT_LENGTH)
  return {
    ok: true,
    pageTitle: extractTitle(html),
    rawText,
    detectedLanguage: detectLanguage(rawText),
  }
}

// ── Adapters ──────────────────────────────────────────────────────────────────

const OfficialWebsiteAdapter: SourceAdapter = {
  name: 'OfficialWebsiteAdapter',
  requiresLogin: false,
  canHandle: (t) => t === 'official_website',
  async extract(url) {
    // Multi-page crawl: homepage + up to 8 subpages (about, contact, products…)
    const result = await fetchWebsiteText(url)
    if (!result) return { ok: false, errorMessage: 'No content fetched from website' }
    const rawText = result.text.slice(0, PAGE_TEXT_LENGTH * 2)
    return {
      ok: true,
      rawText,
      detectedLanguage: detectLanguage(rawText),
    }
  },
}

const CorporateRegistryAdapter: SourceAdapter = {
  name: 'CorporateRegistryAdapter',
  requiresLogin: false,
  canHandle: (t) => t === 'corporate_registry' || t === 'zaubacorp',
  extract: renderedFetch,
}

const LinkedInEvidenceAdapter: SourceAdapter = {
  name: 'LinkedInEvidenceAdapter',
  requiresLogin: true,   // full data (posts, people) needs the RPA scraper with a logged-in session
  canHandle: (t) => t === 'linkedin',
  extract: renderedFetch,   // public company page fields only; authwall → blocked
}

const FacebookPublicPageAdapter: SourceAdapter = {
  name: 'FacebookPublicPageAdapter',
  requiresLogin: true,
  canHandle: (t) => t === 'facebook',
  extract: renderedFetch,
}

const InstagramPublicPageAdapter: SourceAdapter = {
  name: 'InstagramPublicPageAdapter',
  requiresLogin: true,
  canHandle: (t) => t === 'instagram',
  extract: renderedFetch,
}

const YouTubeAdapter: SourceAdapter = {
  name: 'YouTubeAdapter',
  requiresLogin: false,
  canHandle: (t) => t === 'youtube',
  extract: renderedFetch,
}

const NewsArticleAdapter: SourceAdapter = {
  name: 'NewsArticleAdapter',
  requiresLogin: false,
  canHandle: (t) => t === 'news',
  extract: renderedFetch,
}

const GenericDirectoryAdapter: SourceAdapter = {
  name: 'GenericDirectoryAdapter',
  requiresLogin: false,
  canHandle: (t) => t === 'company_directory' || t === 'indiamart' || t === 'tradeindia' || t === 'ambitionbox' || t === 'review_site',
  extract: renderedFetch,
}

const ADAPTERS: SourceAdapter[] = [
  OfficialWebsiteAdapter,
  CorporateRegistryAdapter,
  LinkedInEvidenceAdapter,
  FacebookPublicPageAdapter,
  InstagramPublicPageAdapter,
  YouTubeAdapter,
  NewsArticleAdapter,
  GenericDirectoryAdapter,
]

/** Resolve the adapter for a source type; null = unsupported (evidence-only). */
export function adapterFor(type: DetectedType): SourceAdapter | null {
  return ADAPTERS.find((a) => a.canHandle(type)) ?? null
}
