import type { Lead } from '@/types/lead'

// Inlined to keep content script self-contained (no shared Rollup chunks).
// Unicode property escapes preserve non-Latin scripts (Arabic, Urdu, CJK, etc.)
// so Urdu company names don't collapse to an empty dedup key.
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 80)
}
function nowISO(): string {
  return new Date().toISOString()
}

export interface RawBusinessCard {
  companyName: string
  category?: string
  rating?: number
  reviewCount?: number
  address?: string
  phone?: string
  website?: string
  googleMapsUrl?: string
  rawText: string
}

// ─── DOM Selector Strategies (easy to update if Maps DOM changes) ─────────────

const SELECTORS = {
  // Result list panel containers (try in order)
  resultPanel: [
    'div[role="feed"]',
    'div.m6QErb[aria-label]',
    '.ecceSd',
  ],

  // Individual result cards
  resultCard: [
    'div.Nv2PK',
    'div[jsaction*="mouseover:pane"]',
    'a.hfpxzc',
  ],

  // Card-level selectors (applied within each card element)
  companyName: [
    '.qBF1Pd.fontHeadlineSmall',
    'div.fontHeadlineSmall',
    'span.fontHeadlineSmall',
    '[aria-label]',
  ],
  rating: [
    'span.MW4etd',
    '[aria-label*="stars"]',
    '[aria-label*="rating"]',
  ],
  reviewCount: [
    'span.UY7F9',
    'span[aria-label*="review"]',
  ],
  category: [
    '.W4Efsd:first-of-type .W4Efsd span:not(.UY7F9)',
    'button.W4Efsd',
    '.DkEaL',
  ],
  address: [
    'div.W4Efsd:nth-child(2)',
    '[data-item-id="address"]',
  ],
  phone: [
    'span.UsdlK',
    '[data-tooltip="Copy phone number"]',
    '[data-item-id*="phone"]',
    'span[aria-label*="phone" i]',
  ],
  website: [
    'a[data-value="Website"]',
    'a.lcr4fd[href^="http"]',
    'a[aria-label*="Website" i]',
    'a[data-item-id="authority"]',
    'a[href^="http"]:not([href*="google."]):not([href*="goo.gl"]):not([href*="gstatic"])',
  ],
  mapsLink: [
    'a.hfpxzc',
    'a[href*="/maps/place/"]',
  ],
}

function tryQuerySelector(parent: Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    try {
      const el = parent.querySelector(sel)
      if (el) return el
    } catch {
      // Ignore invalid selectors
    }
  }
  return null
}

function parseRating(el: Element): number | undefined {
  const text = el.textContent?.trim() ?? el.getAttribute('aria-label') ?? ''
  const match = text.match(/(\d+(?:\.\d+)?)/)
  if (match) {
    const val = parseFloat(match[1])
    if (val >= 1 && val <= 5) return val
  }
  return undefined
}

function parseReviewCount(el: Element): number | undefined {
  const text = el.textContent?.trim() ?? el.getAttribute('aria-label') ?? ''
  const match = text.replace(/,/g, '').match(/(\d+)/)
  return match ? parseInt(match[1]) : undefined
}

// Phone regex — handles:
// 1. Indian mobile (10-digit starting 6-9, optional +91 prefix)
// 2. Indian landlines with STD code e.g. "090982 33796" (5-digit STD + space + 5 digits)
//    or "0712-234567". Pattern: 0 + 2-5 STD digits + optional separator + 4-8 more digits.
// 3. US/Canada +1 format
// 4. Generic international
const PHONE_RE = /(?:\+91[\s\-]?)?[6-9]\d{9}|0\d{2,5}[\s\-\.]?\d{4,8}|\+?1[\s\-]?\(?\d{3}\)?[\s\-]\d{3}[\s\-]\d{4}|\+?\d{2,3}[\s\-\.]?\d{6,10}/g

function parsePhoneFromText(text: string): string | undefined {
  const matches = text.match(PHONE_RE)
  if (!matches) return undefined
  const clean = matches.map((m) => m.replace(/[\s\-\.]/g, ''))
  // Prefer numbers with 10+ digits
  const best = clean.find((m) => m.replace(/\D/g, '').length >= 10)
  return best ?? (clean[0]?.replace(/\D/g, '').length >= 7 ? clean[0] : undefined)
}

// Stricter phone picker: returns the best phone-shaped candidate in `text`,
// requiring 8-15 digits and preferring 10-13 (mobiles / STD landlines). Rejects
// short fragments — fixes the "only 5 digits captured" bug where a partial number
// or a pincode/price was accepted.
function normalizePhone(text?: string | null): string | undefined {
  if (!text) return undefined
  const cleanedInput = text.replace(/phone:?/i, '').replace(/copy phone number/i, '')
  const matches = cleanedInput.match(PHONE_RE)
  if (!matches) return undefined
  const candidates = matches
    .map((m) => ({ raw: m.replace(/\s+/g, ' ').trim(), digits: m.replace(/\D/g, '') }))
    .filter((c) => c.digits.length >= 8 && c.digits.length <= 15)
  if (candidates.length === 0) return undefined
  const score = (d: string) => (d.length >= 10 && d.length <= 13 ? 100 + d.length : d.length)
  candidates.sort((a, b) => score(b.digits) - score(a.digits))
  return candidates[0].raw
}

// Google sometimes wraps an external website in a redirect
// (https://www.google.com/url?q=https://realsite.com&…) — unwrap to the real URL
// so it isn't wrongly rejected as a "google.com" link (a big cause of missed websites).
function unwrapGoogleUrl(href: string): string {
  try {
    const u = new URL(href, location.href)
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && (u.pathname === '/url' || u.pathname.startsWith('/aclk'))) {
      const real = u.searchParams.get('q') || u.searchParams.get('url')
      if (real) return real
    }
  } catch { /* not a parseable URL */ }
  return href
}

// Returns a real external website URL, or undefined if the href is a Google/asset
// link. Unwraps redirects first.
function cleanWebsite(href?: string | null): string | undefined {
  if (!href) return undefined
  const url = unwrapGoogleUrl(href.trim())
  if (!/^https?:\/\//i.test(url)) return undefined
  if (/google\.[a-z.]+|goo\.gl|gstatic\.com|ggpht\.com|maps\.app|schema\.org|w3\.org/i.test(url)) return undefined
  return url
}

/**
 * Strip opening-hours status and phone numbers from a raw Google Maps card
 * address row.  The Maps DOM emits text like:
 *   "Print shop · 52, Shani Mandir RdOpen · Closes 9:30 pm · 098933 68152"
 * After cleaning we get: "52, Shani Mandir Rd"
 */
// Strips Google Maps icon-font glyphs, emoji, and replacement boxes that leak
// into scraped text (e.g. a leading "□" rendered before a street address).
function stripJunkGlyphs(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const junk =
      (cp >= 0xE000 && cp <= 0xF8FF) ||   // private-use icon fonts (Material icons)
      cp === 0xFFFC || cp === 0xFFFD || cp === 0xFE0F ||
      (cp >= 0x2190 && cp <= 0x21FF) ||   // arrows
      (cp >= 0x2300 && cp <= 0x27BF) ||   // misc technical / dingbats
      (cp >= 0x2B00 && cp <= 0x2BFF) ||   // misc symbols & arrows
      (cp >= 0x25A0 && cp <= 0x25FF) ||   // geometric shapes (boxes)
      (cp >= 0x1F000 && cp <= 0x1FAFF)    // emoji
    if (!junk) out += ch
  }
  return out
}

function cleanAddressText(raw: string): string {
  let s = stripJunkGlyphs(raw)
    // Cut everything from the first opening-hours marker onward — handles glued
    // text like "73-74Closed Wed" and "…RdOpen · Closes 9 pm".
    .replace(/\s*[·⋅]?\s*(?:Opens?|Close[sd])(?=$|\s|[·⋅]|\d).*$/is, '')
    // Hours/status strings (may be preceded by ·)
    .replace(/\s*·?\s*Open\s+now\s*/gi, ' ')
    .replace(/\s*·?\s*Closes?\s+\d[\d:]*\s*(?:am|pm)\s*/gi, ' ')
    .replace(/\s*·?\s*Opens?(?:\s+at)?\s+\d[\d:]*\s*(?:am|pm)\s*/gi, ' ')
    .replace(/\s*·?\s*Temporarily\s+closed\s*/gi, ' ')
    .replace(/\s*·?\s*Permanently\s+closed\s*/gi, ' ')
    // Bare "Open" / "Closed" status words appended inline (e.g. "RdOpen")
    .replace(/\bOpen\b/gi, '')
    .replace(/\bClosed\b/gi, '')
    // Phone-like digit sequences after a · separator, or trailing
    .replace(/\s*·\s*[\d\s()+\-]{7,}/g, '')
    .replace(/\s+[\d\s()+\-]{9,}$/g, '')
    // Clean up leftover separators and whitespace
    .replace(/^[\s·,]+|[\s·,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // If multiple ·-separated segments remain, drop a leading category-only segment
  // (no digits, no common road/location keywords — it's just a business type label).
  const parts = s.split('·').map(p => p.trim()).filter(Boolean)
  if (parts.length > 1) {
    const looksLikeCategory = (p: string) =>
      !/\d/.test(p) &&
      !/(?:rd\b|road|nagar|colony|chowk|market|marg|sector|lane|street|area|estate|block|phase|plot|near|opp|behind)/i.test(p)
    if (looksLikeCategory(parts[0])) parts.shift()
  }
  return parts.join(', ').replace(/\s+/g, ' ').trim()
}

function extractCardData(card: Element): RawBusinessCard | null {
  const rawText = (card as HTMLElement).innerText || card.textContent || ''

  // Company name — most reliable: aria-label on the card's main place link
  let companyName = ''
  // If card itself IS the link (a.hfpxzc), use it directly; else query inside
  const mainLink: HTMLAnchorElement | null =
    (card.tagName === 'A' && card.classList.contains('hfpxzc'))
      ? card as HTMLAnchorElement
      : (card.querySelector('a.hfpxzc, a[href*="/maps/place/"]') as HTMLAnchorElement | null)

  if (mainLink) {
    companyName = mainLink.getAttribute('aria-label')?.trim() ?? ''
  }
  // Fallback: text-based class selectors (skip generic [aria-label] to avoid false matches)
  if (!companyName) {
    const nameEl = tryQuerySelector(card, [
      '.qBF1Pd.fontHeadlineSmall',
      'div.fontHeadlineSmall',
      'span.fontHeadlineSmall',
    ])
    if (nameEl) companyName = nameEl.textContent?.trim() ?? ''
  }
  companyName = stripJunkGlyphs(companyName).trim()
  if (!companyName) return null

  // Maps URL — from mainLink or any maps/place link
  let googleMapsUrl: string | undefined
  const linkEl = mainLink ?? (card.querySelector('a[href*="/maps/place/"]') as HTMLAnchorElement | null)
  if (linkEl?.href) googleMapsUrl = linkEl.href.split('?')[0]

  // Rating
  let rating: number | undefined
  const ratingEl = tryQuerySelector(card, SELECTORS.rating)
  if (ratingEl) rating = parseRating(ratingEl)

  // Review count
  let reviewCount: number | undefined
  const reviewEl = tryQuerySelector(card, SELECTORS.reviewCount)
  if (reviewEl) reviewCount = parseReviewCount(reviewEl)

  // Category — first text span that isn't the review count
  let category: string | undefined
  const categoryEl = tryQuerySelector(card, SELECTORS.category)
  if (categoryEl) {
    const text = categoryEl.textContent?.trim()
    if (text && text.length < 80 && !text.match(/^\d/)) category = text
  }

  // Address — score every info row and keep the most address-like one, instead
  // of blindly taking the first row with a digit (which grabbed the rating/hours
  // row and produced junk like "Shop 34").
  let address: string | undefined
  {
    const infoRows = Array.from(card.querySelectorAll('.W4Efsd'))
    let bestScore = -1
    for (const row of infoRows) {
      const cleaned = cleanAddressText(row.textContent ?? '')
      if (cleaned.length < 6 || cleaned.length > 220) continue
      let score = Math.min(cleaned.length, 60) / 60
      if (/\d/.test(cleaned)) score += 1
      if (/,/.test(cleaned)) score += 1
      if (/(rd\b|road|nagar|colony|chowk|market|marg|sector|lane|street|st\b|ave|avenue|near|opp|behind|floor|shop|plot|block|phase|building|complex|tower|highway|cross|main|pin|\d{6})/i.test(cleaned)) score += 2
      if (score > bestScore) { bestScore = score; address = cleaned }
    }
  }

  // Phone — prefer the dedicated phone span, then phone-labelled elements, then
  // card text. Everything is run through normalizePhone so partial/short numbers
  // are rejected (fixes the "only 5 digits" bug).
  let phone: string | undefined
  const phoneSpan = card.querySelector('span.UsdlK') as HTMLElement | null
  phone = normalizePhone(phoneSpan?.textContent)
  if (!phone) {
    const phoneEl = tryQuerySelector(card, SELECTORS.phone) as HTMLElement | null
    if (phoneEl) {
      phone = normalizePhone(phoneEl.getAttribute('aria-label'))
        ?? normalizePhone(phoneEl.getAttribute('data-tooltip'))
        ?? normalizePhone(phoneEl.textContent)
    }
  }
  if (!phone) phone = normalizePhone(rawText)

  // Website — unwrap Google redirect links so real sites aren't dropped.
  let website: string | undefined
  const websiteEl = tryQuerySelector(card, SELECTORS.website) as HTMLAnchorElement | null
  website = cleanWebsite(websiteEl?.getAttribute('href'))

  return { companyName, category, rating, reviewCount, address, phone, website, googleMapsUrl, rawText }
}

export function extractResultPanel(): Element | null {
  for (const sel of SELECTORS.resultPanel) {
    const el = document.querySelector(sel)
    if (el) return el
  }
  return null
}

// Extract extra data from the detail panel (popup) that's currently open on screen.
// This panel has phone, website, email, and hours that list cards don't show.
export function extractDetailPanelData(): Partial<RawBusinessCard> {
  // Detail panel — the right-side or overlay panel when a place is selected
  const panel =
    document.querySelector('div[aria-label][role="main"]') ??
    document.querySelector('.m6QErb[aria-label]') ??
    document.querySelector('div.bJzME')

  if (!panel) return {}

  const result: Partial<RawBusinessCard> = {}

  // Phone — button with phone aria-label or data-item-id
  const phoneEl =
    panel.querySelector('[data-item-id^="phone"]') ??
    panel.querySelector('button[aria-label*="Phone" i]') ??
    panel.querySelector('[data-tooltip="Copy phone number"]')
  if (phoneEl) {
    // data-item-id is the most reliable: "phone:tel:+91 98933 68152"
    const itemId = phoneEl.getAttribute('data-item-id')
    result.phone = normalizePhone(itemId)
      ?? normalizePhone(phoneEl.getAttribute('aria-label'))
      ?? normalizePhone(phoneEl.getAttribute('data-tooltip'))
      ?? normalizePhone(phoneEl.textContent)
  }
  if (!result.phone) {
    result.phone = normalizePhone(panel.textContent ?? '')
  }

  // Website — authority link (unwrap redirects), then any non-Google external link.
  const websiteEl = panel.querySelector('a[data-item-id="authority"], a[data-value="Website"]') as HTMLAnchorElement | null
  result.website = cleanWebsite(websiteEl?.getAttribute('href'))
  if (!result.website) {
    for (const a of Array.from(panel.querySelectorAll('a[href^="http"]'))) {
      const w = cleanWebsite((a as HTMLAnchorElement).getAttribute('href'))
      if (w) { result.website = w; break }
    }
  }

  // Email — mailto links
  const emailEl = panel.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null
  if (emailEl) result.rawText = emailEl.href.replace('mailto:', '').trim()

  // Address — the detail panel carries the FULL address (list cards truncate it).
  const addrEl =
    panel.querySelector('button[data-item-id="address"]') ??
    panel.querySelector('[data-item-id="address"]') ??
    panel.querySelector('[aria-label*="Address" i]')
  if (addrEl) {
    let text = (addrEl.getAttribute('aria-label')?.replace(/^\s*address:?/i, '').trim())
      || addrEl.textContent?.trim() || ''
    text = cleanAddressText(text)
    if (text) result.address = text
  }

  return result
}

// Extracts the single business shown when Google Maps redirects a search
// straight to a /maps/place/... page instead of a results list — common when
// the search text closely matches one business's exact listed name (e.g. a
// business that stuffs multiple category keywords into its display name).
// Without this fallback, capture would find zero result cards on this page
// shape and silently end the session with nothing, wasting the whole attempt
// even though the one exact match is sitting right there on screen.
export function extractSingleBusinessFromPlacePage(): RawBusinessCard | null {
  const heading =
    document.querySelector('h1.DUwDvf')?.textContent?.trim() ??
    document.querySelector('[role="main"] h1')?.textContent?.trim() ??
    document.querySelector('div[aria-label][role="main"]')?.getAttribute('aria-label')?.trim()
  if (!heading) return null

  const detail = extractDetailPanelData()
  const category = document.querySelector('button[jsaction*="category"]')?.textContent?.trim()
    ?? document.querySelector('.DkEaL')?.textContent?.trim()

  const ratingEl = document.querySelector('span.ceNzKf, div.F7nice span[aria-hidden="true"]')
  const rating = ratingEl ? parseRating(ratingEl) : undefined
  const reviewCountEl = document.querySelector('span[aria-label*="review"]')
  const reviewCount = reviewCountEl ? parseReviewCount(reviewCountEl) : undefined

  const rawText = (document.querySelector('[role="main"]') as HTMLElement)?.innerText?.slice(0, 500) ?? heading

  return {
    companyName: heading,
    category,
    rating,
    reviewCount,
    address: detail.address,
    phone: detail.phone,
    website: detail.website,
    googleMapsUrl: location.href.split('?')[0],
    rawText,
  }
}

export function extractVisibleCards(): RawBusinessCard[] {
  const seen = new Set<string>()
  const cards: RawBusinessCard[] = []

  // Strategy 1: standard card containers
  for (const sel of SELECTORS.resultCard) {
    const elements = document.querySelectorAll(sel)
    if (elements.length === 0) continue

    for (const el of Array.from(elements)) {
      const data = extractCardData(el)
      if (!data) continue
      const key = data.googleMapsUrl ?? data.companyName
      if (seen.has(key)) continue
      seen.add(key)
      cards.push(data)
    }
    if (cards.length > 0) break
  }

  if (cards.length > 0) return cards

  // Strategy 2: find all place links in the feed and walk up to card container
  const panel = extractResultPanel()
  if (!panel) return cards

  const placeLinks = panel.querySelectorAll('a[href*="/maps/place/"]')
  for (const link of Array.from(placeLinks)) {
    // Walk up to find the card container (has meaningful amount of text)
    let container: Element | null = link.parentElement
    for (let i = 0; i < 5 && container; i++) {
      if ((container.textContent?.length ?? 0) > 40) break
      container = container.parentElement
    }
    const data = extractCardData(container ?? link)
    if (!data) continue
    const key = data.googleMapsUrl ?? data.companyName
    if (seen.has(key)) continue
    seen.add(key)
    cards.push(data)
  }

  return cards
}

export function buildLead(
  raw: RawBusinessCard,
  sessionId: number,
  city: string,
  keyword: string,
  searchQuery: string
): Omit<Lead, 'id'> {
  return {
    sessionId,
    companyName: raw.companyName,
    normalizedName: normalizeName(raw.companyName),
    category: raw.category,
    rating: raw.rating,
    reviewCount: raw.reviewCount,
    address: raw.address,
    phone: raw.phone,
    website: raw.website,
    googleMapsUrl: raw.googleMapsUrl,
    searchQuery,
    city,
    keyword,
    source: 'google_maps',
    rawText: raw.rawText.slice(0, 500),
    confidence: raw.googleMapsUrl ? 0.95 : 0.7,
    status: 'new',
    capturedAt: nowISO(),
    updatedAt: nowISO(),
  }
}
