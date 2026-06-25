import type { Lead } from '@/types/lead'

// Inlined to keep content script self-contained (no shared Rollup chunks)
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)
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
    '[data-tooltip="Copy phone number"]',
    '[data-item-id*="phone"]',
    'span[aria-label*="phone"]',
  ],
  website: [
    'a[data-item-id="authority"]',
    'a[href^="http"]:not([href*="google.com"])',
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

  // Address — heuristic: row containing digits, long enough to be an address
  let address: string | undefined
  const infoRows = card.querySelectorAll('.W4Efsd')
  for (const row of Array.from(infoRows)) {
    const text = row.textContent?.trim() ?? ''
    if (text.match(/\d/) && text.length > 10 && text.length < 200) {
      address = text.replace(/\s+/g, ' ')
      break
    }
  }

  // Phone — try DOM selectors first, then parse from rawText
  let phone: string | undefined
  const phoneEl = tryQuerySelector(card, SELECTORS.phone) as HTMLElement | null
  if (phoneEl) {
    phone = phoneEl.getAttribute('data-tooltip')?.replace('Copy phone number', '').trim()
      ?? phoneEl.getAttribute('aria-label')?.replace(/phone:/i, '').trim()
      ?? phoneEl.textContent?.trim()
  }
  // Fallback: extract phone from visible card text (catches list-view phone numbers)
  if (!phone) phone = parsePhoneFromText(rawText)

  // Website
  let website: string | undefined
  const websiteEl = tryQuerySelector(card, SELECTORS.website) as HTMLAnchorElement | null
  if (websiteEl?.href && !websiteEl.href.includes('google.com')) website = websiteEl.href

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
    panel.querySelector('[data-item-id*="phone"]') ??
    panel.querySelector('[aria-label*="Phone"]') ??
    panel.querySelector('[data-tooltip="Copy phone number"]')
  if (phoneEl) {
    const raw = phoneEl.getAttribute('aria-label') ??
      phoneEl.getAttribute('data-tooltip') ??
      phoneEl.textContent ?? ''
    const cleaned = raw.replace(/phone:/i, '').replace(/copy phone number/i, '').trim()
    if (cleaned) result.phone = cleaned
  }
  if (!result.phone) {
    result.phone = parsePhoneFromText(panel.textContent ?? '')
  }

  // Website — authority link
  const websiteEl = panel.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null
  if (websiteEl?.href && !websiteEl.href.includes('google.com')) {
    result.website = websiteEl.href
  }
  if (!result.website) {
    const anyLink = Array.from(panel.querySelectorAll('a[href^="http"]')).find(
      (a) => {
        const href = (a as HTMLAnchorElement).href
        return !href.includes('google.com') && !href.includes('goo.gl') && !href.includes('maps.app')
      }
    ) as HTMLAnchorElement | null
    if (anyLink) result.website = anyLink.href
  }

  // Email — mailto links
  const emailEl = panel.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null
  if (emailEl) result.rawText = emailEl.href.replace('mailto:', '').trim()

  // Address
  const addrEl =
    panel.querySelector('[data-item-id="address"]') ??
    panel.querySelector('[aria-label*="Address"]')
  if (addrEl) {
    const text = addrEl.getAttribute('aria-label')?.replace(/address:/i, '').trim()
      ?? addrEl.textContent?.trim()
    if (text) result.address = text
  }

  return result
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
