// Multi-source web fetcher for Indian SMB lead enrichment.
//
// Every source below is visited one-by-one in a real (background) browser tab
// — not a raw fetch() — via fetchRenderedHtml(). This avoids bot/CAPTCHA
// detection on Google/IndiaMART/JustDial (which a plain fetch() from the
// service worker context is much more likely to trigger at scale) and
// captures JS-rendered content. The HTML returned is the same shape a raw
// fetch() would have produced, so all the existing regex-based parsers below
// are reused unchanged.

import { fetchRenderedHtml } from './socialScraper'

const MAX_TEXT_LENGTH = 6000
const FETCH_TIMEOUT_MS = 10000
const PAGE_TEXT_LENGTH = 1500  // per sub-page
const DIR_PAGE_TEXT_LENGTH = 2500  // per directory page (Zaubacorp, AmbitionBox, etc.)

// ─── Social URL extraction ────────────────────────────────────────────────────

export function extractSocialUrls(html: string): Record<string, string> {
  const found: Record<string, string> = {}
  const patterns: [string, RegExp][] = [
    ['linkedIn',  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[\w\-%.]+\/?/i],
    ['facebook',  /https?:\/\/(?:www\.)?facebook\.com\/[\w.\-]+\/?(?:\?[^\s"'<>]*)?/i],
    ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[\w.\-]+\/?/i],
    ['twitter',   /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[\w.\-]+\/?/i],
    ['youtube',   /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@)[\w.\-/]+/i],
    ['whatsapp',  /https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\d+/i],
  ]
  for (const [key, re] of patterns) {
    const m = html.match(re)
    if (m) found[key] = m[0].replace(/["'\\>]+$/, '')
  }
  return found
}

// Personal/webmail domains — almost never a business contact email
const WEBMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.in', 'hotmail.com', 'outlook.com', 'live.com', 'rediffmail.com', 'ymail.com']

// Extract business email addresses from text (filters out webmail and noise)
export function extractEmails(text: string, allowWebmail = false): string[] {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
  const found = text.match(re) ?? []
  const unique = [...new Set(found)].filter(
    (e) => !e.includes('sentry') && !e.includes('example') && !e.includes('wix') &&
            !e.includes('wordpress') && !e.includes('@2x') && !e.includes('png') &&
            !e.includes('jpg') && !e.endsWith('.png') && !e.endsWith('.jpg')
  )
  // Prefer business emails; only include webmail if nothing else found
  const business = unique.filter((e) => !WEBMAIL_DOMAINS.some((d) => e.toLowerCase().endsWith('@' + d)))
  // For company website: include webmail if that's all they have (Indian SMBs often use Gmail as primary)
  if (allowWebmail && business.length === 0) return unique.slice(0, 3)
  return business
}

// ─── HTML stripping ────────────────────────────────────────────────────────────

export function stripHtml(html: string, maxLen = MAX_TEXT_LENGTH): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article|footer|span)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen)
}

// Visits the URL in a real background tab and returns the rendered HTML.
// Single choke point so every call site below stays unchanged.
async function safeFetch(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  return fetchRenderedHtml(url, timeoutMs)
}

// ─── Source: Company website (multi-page crawl) ───────────────────────────────
// Fetches homepage + discovers and fetches sub-pages (About, Team, Services,
// Products, Contact) to extract maximum data from the company website.

// Page priority keywords mapped to URL slug patterns to look for
const SUBPAGE_PATTERNS: { label: string; slugs: string[] }[] = [
  { label: 'Contact',        slugs: ['contact', 'contact-us', 'contactus', 'reach-us', 'get-in-touch'] },
  { label: 'About',          slugs: ['about', 'about-us', 'aboutus', 'company', 'who-we-are', 'our-story', 'overview', 'company-profile'] },
  { label: 'Team',           slugs: ['team', 'our-team', 'leadership', 'management', 'people', 'directors', 'founders', 'board'] },
  { label: 'Services',       slugs: ['services', 'our-services', 'what-we-do', 'solutions', 'offerings'] },
  { label: 'Products',       slugs: ['products', 'our-products', 'catalogue', 'catalog', 'portfolio'] },
  { label: 'Clients',        slugs: ['clients', 'our-clients', 'customers', 'clientele', 'client-list', 'our-customers', 'partners', 'associations'] },
  { label: 'Achievements',   slugs: ['achievements', 'awards', 'certifications', 'accreditations', 'recognition', 'milestones', 'quality'] },
  { label: 'Infrastructure', slugs: ['infrastructure', 'facility', 'facilities', 'manufacturing', 'plant', 'capacity'] },
]

function extractInternalLinks(html: string, base: string): string[] {
  const domain = new URL(base).hostname
  const hrefRe = /href="([^"]+)"/gi
  const links = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = m[1]
    if (raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue
    try {
      const full = raw.startsWith('http') ? raw : new URL(raw, base).href
      if (new URL(full).hostname === domain) links.add(full.split('?')[0].split('#')[0])
    } catch { /* ignore malformed */ }
  }
  return [...links]
}

export async function fetchWebsiteText(
  url: string
): Promise<{ text: string; finalUrl: string; socialUrls: Record<string, string>; emails: string[] } | null> {
  const homeHtml = await safeFetch(url)
  if (!homeHtml) return null

  const socialUrls = extractSocialUrls(homeHtml)
  // allowWebmail=true for company's own website — Indian SMBs often use Gmail as their primary business contact
  const emails = new Set(extractEmails(homeHtml, true))

  const base = url.replace(/\/$/, '')
  const homeText = stripHtml(homeHtml, MAX_TEXT_LENGTH)
  if (homeText.length < 30) return null

  // Discover all internal links from the homepage
  const internalLinks = extractInternalLinks(homeHtml, url)

  // Match discovered links to our priority page patterns
  const pagesToFetch: { label: string; url: string }[] = []
  const usedLabels = new Set<string>()

  for (const { label, slugs } of SUBPAGE_PATTERNS) {
    // First try to find a matching discovered link
    const match = internalLinks.find((link) =>
      slugs.some((slug) => link.toLowerCase().includes('/' + slug))
    )
    if (match) {
      pagesToFetch.push({ label, url: match })
      usedLabels.add(label)
      continue
    }
    // Fallback: try first slug pattern directly
    pagesToFetch.push({ label, url: `${base}/${slugs[0]}` })
    usedLabels.add(label)
  }

  // Visit sub-pages one by one (real tab per page, not parallel)
  const sections: string[] = [`=== Homepage ===\n${homeText}`]
  for (const { label, url: pageUrl } of pagesToFetch.slice(0, 8)) {
    const html = await safeFetch(pageUrl, 8000)
    if (!html) continue
    extractEmails(html, true).forEach((e) => emails.add(e))
    Object.assign(socialUrls, extractSocialUrls(html))
    const text = stripHtml(html, PAGE_TEXT_LENGTH)
    if (text.length > 50) sections.push(`=== ${label} Page ===\n${text}`)
  }

  return {
    text: sections.join('\n\n').slice(0, MAX_TEXT_LENGTH * 2),
    finalUrl: url,
    socialUrls,
    emails: [...emails],
  }
}

// ─── Source: Google Search (dual query) ───────────────────────────────────────
// Runs TWO searches in parallel:
//   1. General: finds social profiles, website, directory listings
//   2. People:  finds CEO, directors, founders, contact emails (mimics AI overview)
// Google wraps all result links as /url?q=ACTUAL_URL&sa=... — we decode those.
// JSON-LD structured data embedded by Google in the search page is also extracted.

const SOCIAL_DOMAINS = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com']
const DIRECTORY_DOMAINS = ['justdial.com', 'indiamart.com', 'sulekha.com', 'tradeindia.com', 'zaubacorp.com', 'tracxn.com', 'ambitionbox.com', 'zauba.com']

// Titles that signal a decision-maker / key person
const LEADERSHIP_TITLES = [
  'Managing Director', 'MD', 'Chief Executive', 'CEO', 'Director', 'Founder',
  'Co-Founder', 'Owner', 'Proprietor', 'Chairman', 'Partner', 'President',
  'Head of', 'General Manager', 'GM', 'VP ', 'Vice President',
]

// Extract people found in Google search results.
// Google shows LinkedIn personal profiles as: "Full Name - Job Title" in result titles.
// We extract Name + Role pairs and their LinkedIn /in/ URLs.
function extractPeopleFromGoogle(html: string): { name: string; role: string; linkedIn?: string }[] {
  const people: { name: string; role: string; linkedIn?: string }[] = []

  // Build personal LinkedIn URL → slug map from hrefs
  const linkedInMap: Record<string, string> = {}
  const liRe = /href="[^"]*linkedin\.com\/in\/([\w\-]+)[^"]*"/gi
  let m: RegExpExecArray | null
  while ((m = liRe.exec(html)) !== null) {
    linkedInMap[m[1].toLowerCase()] = `https://www.linkedin.com/in/${m[1]}`
  }

  // Strip to plain text then scan for "Name - Leadership Title" patterns
  // These appear as Google result titles (h3 equivalent in stripped text)
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<h3[^>]*>/gi, '\n##TITLE## ')
    .replace(/<\/h3>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')

  const titlePattern = new RegExp(
    `##TITLE##\\s*([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,3})\\s*[-–]\\s*(${LEADERSHIP_TITLES.join('|')}[^\\n]{0,60})`,
    'g'
  )

  while ((m = titlePattern.exec(text)) !== null) {
    const name = m[1].trim()
    const role = m[2].trim().replace(/\s+/g, ' ')
    if (people.some((p) => p.name === name)) continue

    // Try to find a matching LinkedIn /in/ URL by checking if the name slug appears
    const nameSlug = name.toLowerCase().replace(/\s+/g, '-')
    const liUrl = Object.entries(linkedInMap).find(([slug]) => slug.includes(nameSlug.split('-')[0]))?.[1]

    people.push({ name, role, linkedIn: liUrl })
  }

  return people
}

function decodeGoogleUrl(raw: string): string {
  const m = raw.match(/[?&]q=(https?[^&"]+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return raw
}

// Extract JSON-LD blocks Google embeds in search pages (knowledge panel, structured results)
function extractJsonLd(html: string): string {
  const blocks: string[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1])
      // Only keep business-relevant types
      const type = obj['@type'] ?? ''
      if (/Organization|LocalBusiness|Corporation|Person|Employee|Place/i.test(type)) {
        blocks.push(JSON.stringify(obj, null, 1))
      }
    } catch { /* malformed JSON — skip */ }
  }
  return blocks.join('\n')
}

function parseGoogleHtml(html: string, companyName: string): {
  socialUrls: Record<string, string>
  directoryUrls: string[]
  websiteUrl: string | null
  snippetText: string
  emails: string[]
  jsonLd: string
  people: { name: string; role: string; linkedIn?: string }[]
} {
  const hrefRe = /href="([^"]+)"/gi
  const socialUrls: Record<string, string> = {}
  const directoryUrls: string[] = []
  let websiteUrl: string | null = null
  let m: RegExpExecArray | null

  while ((m = hrefRe.exec(html)) !== null) {
    const decoded = decodeGoogleUrl(m[1])

    for (const domain of SOCIAL_DOMAINS) {
      if (decoded.includes(domain) && !decoded.includes('google.com')) {
        const key = domain.replace('.com', '').replace('x.com', 'twitter')
        if (!socialUrls[key]) socialUrls[key] = decoded.split('?')[0]
      }
    }

    for (const domain of DIRECTORY_DOMAINS) {
      if (decoded.includes(domain)) {
        const clean = decoded.split('?')[0]
        if (!directoryUrls.includes(clean)) directoryUrls.push(clean)
      }
    }

    if (
      decoded.startsWith('https://') &&
      !decoded.includes('google.com') &&
      !decoded.includes('googleapis.com') &&
      !decoded.includes('wikipedia.org') &&
      !decoded.includes('youtube.com') &&
      !decoded.includes('maps.google') &&
      !SOCIAL_DOMAINS.some((d) => decoded.includes(d)) &&
      !DIRECTORY_DOMAINS.some((d) => decoded.includes(d))
    ) {
      // Accept ANY non-google/social/directory URL — companies often have URLs that
      // don't contain their name (e.g. "Gupta Publishing House" → "gphbooks.com")
      if (!websiteUrl) websiteUrl = decoded.split('?')[0]
    }
  }

  return {
    socialUrls,
    directoryUrls,
    websiteUrl,
    snippetText: stripHtml(html, 4000),
    emails: extractEmails(html),
    jsonLd: extractJsonLd(html),
    people: extractPeopleFromGoogle(html),
  }
}

// Directory domains whose pages we actively fetch for rich company data
// Priority order: Zaubacorp (Indian registry — directors, revenue, CIN), then others
const FETCH_PRIORITY_DOMAINS = [
  'zaubacorp.com',
  'ambitionbox.com',
  'tracxn.com',
  'tradeindia.com',
  'exportersindia.com',
  'sulekha.com',
]

async function fetchDirectoryPages(directoryUrls: string[]): Promise<string> {
  // Pick top 3 — prioritise domains we know are data-rich
  const sorted = [...directoryUrls].sort((a, b) => {
    const ai = FETCH_PRIORITY_DOMAINS.findIndex((d) => a.includes(d))
    const bi = FETCH_PRIORITY_DOMAINS.findIndex((d) => b.includes(d))
    const an = ai === -1 ? 999 : ai
    const bn = bi === -1 ? 999 : bi
    return an - bn
  })

  const toFetch = sorted.slice(0, 3)
  const sections: string[] = []
  for (const url of toFetch) {
    const html = await safeFetch(url, 12000)
    if (!html) continue
    const text = stripHtml(html, DIR_PAGE_TEXT_LENGTH)
    if (text.length < 80) continue
    const domain = new URL(url).hostname.replace('www.', '')
    sections.push(`=== ${domain} (${url}) ===\n${text}`)
  }

  return sections.join('\n\n')
}

// Google's bot-detection interstitial ("Our systems have detected unusual
// traffic...") — must be checked before treating a fetch as a real result,
// otherwise the block page gets silently parsed as empty search results.
function isGoogleBlocked(html: string | null): boolean {
  if (!html) return false
  return /unusual traffic|detected unusual traffic|systems have detected|recaptcha/i.test(html) && html.length < 20000
}

// Once Google blocks us, hitting it again immediately only extends the
// block. Back off for the rest of this extension session.
let googleBlockedUntil = 0
const GOOGLE_BLOCK_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

export async function fetchGoogleSearchData(companyName: string, city: string): Promise<{ text: string; discoveredWebsite: string | null; searchUrl: string } | null> {
  if (Date.now() < googleBlockedUntil) return null

  const base = `https://www.google.com/search?num=10&hl=en&gl=in&q=`

  // A single combined query covering website/social, leadership, and
  // financial/registry signals. Firing 3 separate google.com/search hits per
  // lead (one per topic) tripled request volume from the same browser/IP for
  // every lead — that was the main driver of Google's bot detection, not pacing.
  const q1 = encodeURIComponent(
    `"${companyName}" ${city} CEO OR director OR founder OR owner contact email annual turnover OR employees OR CIN`
  )

  const searchUrl = `${base}${q1}`
  const html1 = await safeFetch(searchUrl, 15000)

  if (isGoogleBlocked(html1)) {
    googleBlockedUntil = Date.now() + GOOGLE_BLOCK_COOLDOWN_MS
    return null
  }

  if (!html1) return null

  const p1 = parseGoogleHtml(html1, companyName)
  const p2 = null
  const p3 = null

  // Merge results — p1 takes priority for URLs
  const socialUrls = { ...(p2?.socialUrls ?? {}), ...(p1?.socialUrls ?? {}) }
  const directoryUrls = [...new Set([
    ...(p1?.directoryUrls ?? []),
    ...(p2?.directoryUrls ?? []),
    ...(p3?.directoryUrls ?? []),
  ])]
  const websiteUrl = p1?.websiteUrl ?? p2?.websiteUrl
  const allEmails = [...new Set([...(p1?.emails ?? []), ...(p2?.emails ?? []), ...(p3?.emails ?? [])])]
  const jsonLd = [p1?.jsonLd, p2?.jsonLd, p3?.jsonLd].filter(Boolean).join('\n')

  // Merge people from all queries, deduplicate by name
  const allPeople = [...(p1?.people ?? []), ...(p2?.people ?? []), ...(p3?.people ?? [])]
  const uniquePeople = allPeople.filter((p, i) => allPeople.findIndex((x) => x.name === p.name) === i)

  // ── CRITICAL: Actually fetch directory pages for rich data ──────────────────
  // Zaubacorp has directors, revenue, CIN, legal status for every Indian company.
  // AmbitionBox has employee count and company type. We fetch these instead of just listing URLs.
  const directoryPageText = directoryUrls.length > 0
    ? await fetchDirectoryPages(directoryUrls)
    : ''

  const result: string[] = []

  if (Object.keys(socialUrls).length) {
    result.push('Social media profiles found on Google:\n' +
      Object.entries(socialUrls).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
  }

  if (uniquePeople.length) {
    result.push(
      'Key people found in Google search results (IMPORTANT — use for decisionMaker and teamMembers):\n' +
      uniquePeople.map((p) =>
        `  ${p.name} — ${p.role}${p.linkedIn ? ` | LinkedIn: ${p.linkedIn}` : ''}`
      ).join('\n')
    )
  }

  if (directoryPageText.length > 80) {
    result.push(
      'Directory pages fetched (Zaubacorp, AmbitionBox, etc. — VERY RELIABLE for Indian company data):\n' +
      'Extract: directors, revenue/turnover, employee count, CIN, legal status, established year.\n\n' +
      directoryPageText
    )
  } else if (directoryUrls.length) {
    result.push('Directory listings found on Google:\n' +
      directoryUrls.slice(0, 8).map((u) => `  ${u}`).join('\n'))
  }

  if (websiteUrl) result.push(`Company website found on Google: ${websiteUrl}`)
  if (allEmails.length) result.push(`Emails found on Google (may include webmail — include if found on company website): ${allEmails.join(', ')}`)

  if (jsonLd.length > 20) {
    result.push(`Google structured data (JSON-LD — highly reliable):\n${jsonLd.slice(0, 2000)}`)
  }

  if (p1?.snippetText && p1.snippetText.length > 100) {
    result.push(`Google search results for "${companyName} ${city}":\n${p1.snippetText.slice(0, 2000)}`)
  }

  if (p2?.snippetText && p2.snippetText.length > 100) {
    result.push(`Google search results for "${companyName}" leadership & contact:\n${p2.snippetText.slice(0, 2000)}`)
  }

  if (p3?.snippetText && p3.snippetText.length > 100) {
    result.push(`Google search results for "${companyName}" financials & registry:\n${p3.snippetText.slice(0, 2000)}`)
  }

  if (!result.length) return null
  return { text: result.join('\n\n'), discoveredWebsite: websiteUrl ?? null, searchUrl }
}

// ─── Source: JustDial ─────────────────────────────────────────────────────────

export async function fetchJustDialData(companyName: string, city: string): Promise<{ text: string; url: string } | null> {
  const q = encodeURIComponent(companyName)
  const url = `https://www.justdial.com/${city}/${q}/ct-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const html = await safeFetch(url, 8000)
  if (!html) return null

  const text = stripHtml(html, 3000)
  // Only extract emails — do NOT extract social URLs from JustDial (their own FB/LinkedIn
  // in header/footer would be captured, not the company's)
  const emails = extractEmails(html)

  const parts: string[] = []
  if (text.length > 50) parts.push(`JustDial listing:\n${text}`)
  if (emails.length) parts.push(`Emails (JustDial): ${emails.join(', ')}`)
  return parts.length ? { text: parts.join('\n'), url } : null
}

// ─── Source: IndiaMART ────────────────────────────────────────────────────────
// Strategy: search for the company → extract profile URL → fetch profile page
// The profile page has CEO, employee count, turnover, GST, legal status, etc.

export async function fetchIndiaMartData(companyName: string, city: string): Promise<{ text: string; url: string } | null> {
  // IndiaMART company profiles live at indiamart.com/{slug}/ where slug = lowercased name without spaces/punctuation.
  // Try the constructed URL first (most reliable), then fall back to search.
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '')
  const directUrl = `https://www.indiamart.com/${slug}/`

  // Try the direct URL first; only fall back to a search visit if that fails
  const directHtml = await safeFetch(directUrl, 10000)

  let profileUrl: string | null = null
  let profileHtml: string | null = null

  // Direct URL is valid if it's actually a company page (has key IndiaMART company markers)
  if (directHtml && directHtml.includes('indiamart') && directHtml.length > 5000) {
    profileUrl = directUrl
    profileHtml = directHtml
  }

  const searchHtml = profileHtml
    ? null
    : await safeFetch(`https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(`${companyName} ${city}`)}`, 10000)

  // Fallback: parse search results for a company profile link
  if (!profileHtml && searchHtml) {
    // Match indiamart.com/{slug}/ style company pages AND legacy profile.html paths
    const profileRe = /href="(https?:\/\/(?:www\.)?indiamart\.com\/[a-z0-9\-]+\/(?:[a-z0-9\-]*\.html)?)[^"]*"/gi
    let m: RegExpExecArray | null
    while ((m = profileRe.exec(searchHtml)) !== null) {
      const candidate = m[1].split('?')[0]
      // Skip generic IndiaMART pages
      if (candidate.includes('/search') || candidate.includes('/proddetail') || candidate === 'https://www.indiamart.com/') continue
      profileUrl = candidate
      profileHtml = await safeFetch(profileUrl, 10000)
      if (profileHtml) break
    }
  }

  const sourceHtml = profileHtml ?? searchHtml
  if (!sourceHtml) return null

  // Only extract emails — NOT social URLs (IndiaMART footer has their own social links)
  const emails = extractEmails(sourceHtml)
  const text = stripHtml(sourceHtml, 3500)

  const parts: string[] = []
  if (profileUrl) parts.push(`IndiaMART company profile: ${profileUrl}`)
  if (text.length > 50) parts.push(`IndiaMART data (key fields: Company CEO, Total Number of Employees, Annual Turnover, Legal Status of Firm, Nature of Business, GST Number, established year, products):\n${text}`)
  if (emails.length) parts.push(`Emails (IndiaMART): ${emails.join(', ')}`)
  return parts.length
    ? { text: parts.join('\n'), url: profileUrl ?? `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(`${companyName} ${city}`)}` }
    : null
}

// ─── Build AI context from all sources ────────────────────────────────────────

export function buildCompanyContext(
  companyName: string,
  city: string,
  keyword: string,
  websiteText: string | null,
  socialUrls: Record<string, string> = {},
  websiteEmails: string[] = [],
  googleData: string | null = null,
  indiaMartText: string | null = null,
  justDialText: string | null = null,
): string {
  const parts: string[] = [
    `Company: ${companyName}`,
    `Location: ${city}`,
    `Business type: ${keyword}`,
  ]

  // Pre-extracted social URLs (from HTML regex — highest reliability)
  if (Object.keys(socialUrls).length > 0) {
    parts.push('\nPre-extracted social/contact URLs (copy these EXACTLY):')
    for (const [key, url] of Object.entries(socialUrls)) {
      parts.push(`  ${key}: ${url}`)
    }
  }

  if (websiteEmails.length > 0) {
    parts.push(`\nEmails found on website: ${websiteEmails.join(', ')}`)
  }

  if (websiteText) {
    parts.push(`\nWebsite content:\n${websiteText}`)
  }

  if (googleData) {
    parts.push(`\n${googleData}`)
  }

  if (indiaMartText) {
    parts.push(`\n${indiaMartText}`)
  }

  if (justDialText) {
    parts.push(`\n${justDialText}`)
  }

  return parts.join('\n')
}
