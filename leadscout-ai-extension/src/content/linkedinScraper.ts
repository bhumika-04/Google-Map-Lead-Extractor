// ── LeadScout LinkedIn Scraper v2 ─────────────────────────────────────────────
// Automated, service-worker-controlled.  Runs silently on all LinkedIn pages.
// When the SW has an active job, this script scrapes the right data and reports
// it back.  The SW then navigates the tab to the next required page.
//
// Steps controlled by SW:
//   company-profile →  /company/SLUG/about/        — public profile fields
//   company-posts   →  /company/SLUG/posts/         — last 6 months
//   company-people  →  /company/SLUG/people/
//   person-posts    →  /in/USERNAME/recent-activity/all/  (one per core member)
//
// Compliance (Phase 3 LinkedIn Business Intelligence spec): never bypasses
// login/captcha/paywall/robots — if the tab lands on a login/authwall/checkpoint
// page, that is reported back as loginRequired and the step yields no data
// rather than attempting to proceed. Any field not visibly present on the page
// is left as "Not Available" — nothing is inferred.
// ─────────────────────────────────────────────────────────────────────────────

import type { LinkedInPost, LinkedInPerson, LinkedInCompanyProfile, LiScraperStep } from '@/types/linkedinData'
import { NOT_AVAILABLE, CORE_ROLE_TITLES } from '@/types/linkedinData'

// ── Core member title keywords (broad net — used for isCore) ─────────────────

const CORE_KEYWORDS = [
  'founder', 'co-founder', 'cofounder',
  'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cso', 'cpo', 'chro', 'cgo',
  'managing director', 'md', 'executive director',
  'director', 'president', 'vice president', 'vp',
  'head of', 'head -', 'head,', 'head',
  'partner', 'principal', 'owner', 'proprietor',
  'general manager', 'gm',
  'chief', 'board member', 'trustee',
  'hr', 'human resource',
]

function isCore(title: string): boolean {
  const t = title.toLowerCase()
  return CORE_KEYWORDS.some(kw => t.includes(kw))
}

// ── roleCategory classifier — matches the spec's exact 19-title taxonomy ─────
// confidence: 1.0 exact phrase match, 0.7 contains-match, 0.4 generic "head"/
// "director" fallback, 0 ("Other") if nothing matches.

function classifyRole(title: string): { roleCategory: string; confidence: number } {
  const t = title.toLowerCase().trim()
  if (!t) return { roleCategory: 'Other', confidence: 0 }

  for (const role of CORE_ROLE_TITLES) {
    if (t === role.toLowerCase()) return { roleCategory: role, confidence: 1.0 }
  }
  for (const role of CORE_ROLE_TITLES) {
    if (t.includes(role.toLowerCase())) return { roleCategory: role, confidence: 0.7 }
  }
  // Common abbreviations / synonyms not literal substrings of the title list
  const synonymMap: Array<[string[], string]> = [
    [['chief executive officer'], 'CEO'],
    [['chief technology officer'], 'CTO'],
    [['chief operating officer'], 'COO'],
    [['chief financial officer'], 'CFO'],
    [['chief marketing officer'], 'CMO'],
    [['chief growth officer'], 'CGO'],
    [['managing partner'], 'Partner'],
    [['proprietor', 'owner'], 'Founder'],
  ]
  for (const [keywords, role] of synonymMap) {
    if (keywords.some(kw => t.includes(kw))) return { roleCategory: role, confidence: 0.6 }
  }
  if (t.includes('head')) return { roleCategory: 'Director', confidence: 0.4 }
  return { roleCategory: 'Other', confidence: 0 }
}

// ── Deterministic theme / signal detectors — keyword-based, never AI-inferred ─

const HIRING_KEYWORDS = ['hiring', "we're hiring", 'we are hiring', 'open position', 'job opening', 'vacancy', 'vacancies', 'join our team', 'looking for', 'now hiring', 'walk-in interview', 'apply now']
const EXPANSION_KEYWORDS = ['new branch', 'new facility', 'new plant', 'new unit', 'expanding', 'expansion', 'new office', 'opening soon', 'new location', 'scaling up']
const PRODUCT_KEYWORDS = ['launch', 'launching', 'new product', 'introducing', 'unveiling', 'now available', 'new range', 'new collection']
const EVENT_KEYWORDS = ['exhibition', 'expo', 'trade fair', 'webinar', 'conference', 'seminar', 'summit', 'workshop', 'trade show']

function detectSignals(content: string): {
  detectedTheme: string; hiringSignal: boolean; expansionSignal: boolean; productSignal: boolean; eventSignal: boolean
} {
  const c = content.toLowerCase()
  const hiringSignal    = HIRING_KEYWORDS.some(kw => c.includes(kw))
  const expansionSignal = EXPANSION_KEYWORDS.some(kw => c.includes(kw))
  const productSignal   = PRODUCT_KEYWORDS.some(kw => c.includes(kw))
  const eventSignal     = EVENT_KEYWORDS.some(kw => c.includes(kw))
  const detectedTheme =
    hiringSignal ? 'hiring' :
    expansionSignal ? 'expansion' :
    productSignal ? 'product' :
    eventSignal ? 'event' : 'general'
  return { detectedTheme, hiringSignal, expansionSignal, productSignal, eventSignal }
}

function detectBusinessInterest(content: string): string {
  const c = content.toLowerCase()
  if (HIRING_KEYWORDS.some(kw => c.includes(kw)))    return 'hiring'
  if (EXPANSION_KEYWORDS.some(kw => c.includes(kw))) return 'expansion'
  if (PRODUCT_KEYWORDS.some(kw => c.includes(kw)))   return 'product'
  if (EVENT_KEYWORDS.some(kw => c.includes(kw)))     return 'event'
  return NOT_AVAILABLE
}

function mentionsCompany(content: string, companyName: string): boolean {
  if (!companyName) return false
  const norm = (s: string) => s.toLowerCase().replace(/\b(pvt|ltd|private|limited|inc|llp|co)\b\.?/g, '').replace(/[^a-z0-9 ]/g, '').trim()
  const needle = norm(companyName)
  if (!needle) return false
  return norm(content).includes(needle)
}

function parseEngagementCount(likes: string, comments: string): number | null {
  const parseNum = (s: string): number => {
    const m = s.replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/)
    if (!m) return 0
    const n = parseFloat(m[1])
    if (isNaN(n)) return 0
    if (m[2].toLowerCase() === 'k') return Math.round(n * 1000)
    if (m[2].toLowerCase() === 'm') return Math.round(n * 1000000)
    return Math.round(n)
  }
  if (!likes && !comments) return null
  return parseNum(likes) + parseNum(comments)
}

// ── Login-wall / paywall / private-page detection ─────────────────────────────
// Compliance requirement: never bypass login, captcha, paywall, or private
// pages. If the tab has landed on one of these, the step reports loginRequired
// and yields no scraped data.

function isLoginWalled(): boolean {
  const p = location.pathname.toLowerCase()
  return p.includes('/login') || p.includes('/authwall') || p.includes('/checkpoint') ||
         p.includes('/uas/login') || !!document.querySelector('form[action*="login"], #captcha-internal, [data-test-id="captcha"]')
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}
function attr(el: Element | null | undefined, name: string): string {
  return el?.getAttribute(name)?.trim() ?? ''
}
function cleanUrl(href: string): string {
  if (!href) return ''
  const clean = href.split('?')[0].replace(/\/$/, '')
  return clean.startsWith('http') ? clean : `https://www.linkedin.com${clean}`
}
function parseDaysAgo(raw: string): number | null {
  const s = raw.toLowerCase()
  const n = parseInt(s)
  if (isNaN(n)) {
    if (s.includes('just') || s.includes('now')) return 0
    if (s.includes('yesterday'))                  return 1
    return null
  }
  if (s.includes('min') || s.includes('hour')) return 0
  if (s.includes('day'))   return n
  if (s.includes('week'))  return n * 7
  if (s.includes('month')) return n * 30
  if (s.includes('year'))  return n * 365
  return null
}
function cardRoot(el: Element, max = 10): Element {
  let node: Element | null = el
  for (let i = 0; i < max; i++) {
    if (!node?.parentElement) break
    node = node.parentElement
    const tag = node.tagName.toLowerCase()
    if (
      tag === 'li' || tag === 'article' ||
      node.getAttribute('role') === 'listitem' ||
      node.getAttribute('data-urn') ||
      node.getAttribute('data-id') ||
      node.getAttribute('data-entity-urn')
    ) return node
  }
  return el.parentElement ?? el
}

// ── Extraction functions ──────────────────────────────────────────────────────

function extractPosts(kind: 'company' | 'person', companyName: string): LinkedInPost[] {
  const candidates: Element[] = [
    ...Array.from(document.querySelectorAll('[data-urn*="activity"]')),
    ...Array.from(document.querySelectorAll('[data-id*="activity"]')),
    ...Array.from(document.querySelectorAll('article')),
    ...Array.from(document.querySelectorAll('[class*="occludable-update"]')),
    ...Array.from(document.querySelectorAll('[class*="feed-shared-update"]')),
  ]
  const unique = [...new Set(candidates)]
  const roots = unique.filter(el => !unique.some(o => o !== el && o.contains(el)))
  const seenUrns = new Set<string>()
  const posts: LinkedInPost[] = []

  const sixMonthsAgoMs = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000

  for (const c of roots) {
    const urn = attr(c, 'data-urn') || attr(c, 'data-id') || ''
    if (urn && seenUrns.has(urn)) continue
    if (urn) seenUrns.add(urn)

    const actorEl =
      c.querySelector('[class*="actor"]') ??
      c.querySelector('[class*="author"]') ??
      c.querySelector('[class*="update-components-actor"]')

    const authorNameEl =
      actorEl?.querySelector('a span[aria-hidden="true"]') ??
      actorEl?.querySelector('span[aria-hidden="true"]') ??
      c.querySelector('[class*="actor__name"] span[aria-hidden="true"]')

    const authorTitleEl =
      actorEl?.querySelector('[class*="description"] span[aria-hidden="true"]') ??
      actorEl?.querySelector('[class*="subtitle"] span[aria-hidden="true"]')

    const authorLinkEl =
      actorEl?.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
      actorEl?.querySelector<HTMLAnchorElement>('a[href*="/company/"]')

    const contentEl =
      c.querySelector('[class*="commentary"]') ??
      c.querySelector('[class*="update-components-text"]') ??
      c.querySelector('[class*="feed-shared-text"]') ??
      c.querySelector('[dir="ltr"]')

    const timeEl    = c.querySelector('time')
    const dateTextEl = timeEl ?? actorEl?.querySelector('[class*="sub-description"] span[aria-hidden="true"]')
    const rawDate    = text(dateTextEl)
    const daysAgo    = parseDaysAgo(rawDate)
    const datetimeAttr = attr(timeEl, 'datetime')
    const postDateIso = datetimeAttr || (daysAgo !== null ? new Date(Date.now() - daysAgo * 86400000).toISOString() : null)
    const postMs = postDateIso ? new Date(postDateIso).getTime() : null

    const likesEl    = c.querySelector('[class*="reactions-count"]') ?? c.querySelector('[class*="social-counts"] [class*="reaction"]') ?? c.querySelector('[aria-label*="reaction"]')
    const commentsEl = c.querySelector('[class*="social-counts"] a[href*="comment"]') ?? c.querySelector('[aria-label*="comment"]') ?? c.querySelector('[class*="comments-count"]')
    const postLinkEl = c.querySelector<HTMLAnchorElement>('a[href*="/posts/"]') ?? c.querySelector<HTMLAnchorElement>('a[href*="/feed/update/"]')

    const mediaType =
      c.querySelector('video, [class*="linkedin-video"]') ? 'video' :
      c.querySelector('[class*="image"] img')             ? 'image' :
      c.querySelector('[class*="document"]')              ? 'document' :
      c.querySelector('[class*="poll"]')                  ? 'poll' : 'text'

    const author  = text(authorNameEl)
    const content = text(contentEl).slice(0, 1000)
    if (!author && !content) continue

    const likes = text(likesEl)
    const comments = text(commentsEl)
    const signals = detectSignals(content)

    posts.push({
      author,
      authorTitle:      text(authorTitleEl),
      authorProfileUrl: cleanUrl(attr(authorLinkEl, 'href')),
      content,
      relativeDate:     rawDate,
      postDateIso,
      daysAgo,
      withinMonth:      daysAgo !== null && daysAgo <= 30,
      withinSixMonths:  postMs !== null ? postMs >= sixMonthsAgoMs : (daysAgo !== null ? daysAgo <= 183 : false),
      likes,
      comments,
      engagementCount:  parseEngagementCount(likes, comments),
      postUrl:          cleanUrl(attr(postLinkEl, 'href')),
      mediaType,
      urn,
      ...(kind === 'company'
        ? signals
        : {
            detectedTheme: signals.detectedTheme,
            hiringSignal: signals.hiringSignal,
            expansionSignal: false,
            productSignal: false,
            eventSignal: false,
            businessInterest: detectBusinessInterest(content),
            companyMention: mentionsCompany(content, companyName),
          }),
    })
  }
  return posts
}

function extractPeople(): LinkedInPerson[] {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')
  const seen = new Set<string>()
  const people: LinkedInPerson[] = []

  for (const anchor of Array.from(anchors)) {
    const href = attr(anchor, 'href').split('?')[0]
    if (!href || seen.has(href)) continue
    if (!/^(https?:\/\/www\.linkedin\.com)?\/in\/[^/]+/.test(href)) continue
    seen.add(href)

    const card = cardRoot(anchor)
    const nameEl =
      card.querySelector('a[href*="/in/"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="title"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="name"] span[aria-hidden="true"]') ??
      card.querySelector('span[aria-hidden="true"]')

    const titleEl =
      card.querySelector('[class*="subtitle"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="description"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="headline"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="position"] span[aria-hidden="true"]')

    const locEl =
      card.querySelector('[class*="caption"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="location"] span[aria-hidden="true"]')

    const imgEl =
      card.querySelector<HTMLImageElement>('img[src*="licdn"], img[src*="profile"]') ??
      card.querySelector<HTMLImageElement>('img')

    const name  = text(nameEl)
    const title = text(titleEl)
    if (!name && !href) continue

    const profileUrl = cleanUrl(href)
    const usernameMatch = profileUrl.match(/\/in\/([^/]+)/)
    const activityUrl = usernameMatch
      ? `https://www.linkedin.com/in/${usernameMatch[1]}/recent-activity/all/`
      : ''

    const { roleCategory, confidence } = classifyRole(title)

    people.push({
      name,
      title: title || NOT_AVAILABLE,
      location:   text(locEl) || NOT_AVAILABLE,
      profileUrl,
      imageUrl:   imgEl?.src ?? '',
      isCore:     isCore(title),
      activityUrl,
      roleCategory,
      confidence,
    })
  }
  return people
}

function extractCompanyProfile(companyName: string): LinkedInCompanyProfile {
  const field = (labels: string[]): string => {
    for (const label of labels) {
      const dt = Array.from(document.querySelectorAll('dt, h3, [class*="overview-card"] h3'))
        .find(el => text(el).toLowerCase().includes(label.toLowerCase()))
      if (dt) {
        const dd = dt.nextElementSibling
        const v = text(dd)
        if (v) return v
      }
    }
    return NOT_AVAILABLE
  }

  const industry    = field(['industry'])
  const companySize  = field(['company size'])
  const location     = field(['headquarters', 'location'])

  const followersEl = Array.from(document.querySelectorAll('[class*="follower"]')).find(el => /follower/i.test(text(el)))
  const followersMatch = text(followersEl).match(/[\d,.]+[kKmM]?\s*follower/i)
  const followers = followersMatch ? followersMatch[0].replace(/follower.*/i, '').trim() : NOT_AVAILABLE

  const aboutEl =
    document.querySelector('[class*="about-us"] p') ??
    document.querySelector('section[class*="about"] p') ??
    Array.from(document.querySelectorAll('section')).find(sec => text(sec.querySelector('h2')).toLowerCase().includes('overview'))?.querySelector('p')
  const aboutText = text(aboutEl) || NOT_AVAILABLE

  const nameEl = document.querySelector('h1')
  const companyNameOnPage = text(nameEl) || companyName || NOT_AVAILABLE

  return {
    companyName: companyNameOnPage,
    linkedinUrl: location_href_company(),
    industry,
    companySize,
    followers,
    location,
    aboutText,
  }
}

function location_href_company(): string {
  const m = location.pathname.match(/\/company\/([^/]+)/)
  return m ? `https://www.linkedin.com/company/${m[1]}/` : location.href
}

// ── Wait & scroll helpers ─────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Wait up to timeoutMs for at least one element matching any selector */
async function waitForContent(selectors: string[], timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (selectors.some(s => document.querySelectorAll(s).length > 0)) return true
    await sleep(600)
  }
  return false
}

/** Scroll down gently to trigger LinkedIn lazy-loading, up to 10x for a 6-month window */
async function gentleScroll(rounds = 3): Promise<void> {
  const step = window.innerHeight * 0.8
  for (let i = 0; i < rounds; i++) {
    window.scrollBy({ top: step, behavior: 'smooth' })
    await sleep(1500)
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
  await sleep(800)
}

// ── Status badge ──────────────────────────────────────────────────────────────

let badge: HTMLElement | null = null

function showBadge(msg: string, kind: 'info' | 'ok' | 'err' = 'info') {
  if (!badge) {
    badge = document.createElement('div')
    badge.id = 'ls-scraper-badge'
    Object.assign(badge.style, {
      position: 'fixed', top: '14px', right: '14px', zIndex: '999999',
      padding: '10px 16px', borderRadius: '8px',
      fontSize: '13px', fontWeight: '700', fontFamily: 'system-ui, sans-serif',
      color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      maxWidth: '300px', lineHeight: '1.4', pointerEvents: 'none',
    })
    document.body.appendChild(badge)
  }
  badge.style.background = kind === 'err' ? '#dc2626' : kind === 'ok' ? '#16a34a' : '#0a66c2'
  badge.textContent = `🔍 LeadScout: ${msg}`
}

function removeBadge(delay = 3000) {
  setTimeout(() => { badge?.remove(); badge = null }, delay)
}

// ── Main scraper logic ────────────────────────────────────────────────────────

interface ScrapeResult {
  posts?: LinkedInPost[]
  people?: LinkedInPerson[]
  profile?: LinkedInCompanyProfile
  loginRequired?: boolean
}

async function scrape(step: LiScraperStep, companyName: string): Promise<ScrapeResult> {
  // Compliance gate — never proceed past a login/captcha/paywall/checkpoint page.
  if (isLoginWalled()) {
    showBadge('Login/checkpoint required — skipping (no bypass)', 'err')
    return { loginRequired: true }
  }

  if (step === 'company-profile') {
    showBadge('Reading company profile…')
    await waitForContent(['h1', '[class*="overview-card"]', 'dt'], 8000)
    await sleep(800)
    const profile = extractCompanyProfile(companyName)
    showBadge('Company profile captured', 'ok')
    return { profile }
  }

  if (step === 'company-posts' || step === 'person-posts') {
    showBadge('Loading posts (last 6 months)…')
    const postSelectors = [
      '[data-urn*="activity"]',
      '[data-id*="activity"]',
      'article',
      '[class*="occludable-update"]',
      '[class*="feed-shared-update"]',
      '[class*="social-feed-update"]',
      '[class*="update-components-text"]',
    ]
    await waitForContent(postSelectors)
    // Scroll further than a 30-day window would need, to surface up to 6 months of posts
    await gentleScroll(6)
    const posts = extractPosts(step === 'company-posts' ? 'company' : 'person', companyName)
    const inWindow = posts.filter(p => p.withinSixMonths).length
    showBadge(`${posts.length} posts captured (${inWindow} in last 6 months)`, 'ok')
    return { posts }
  }

  if (step === 'company-people') {
    showBadge('Loading team members…')
    await waitForContent(['a[href*="/in/"]', '[class*="member-list"]', '[class*="people-list"]'])
    await gentleScroll()
    const people = extractPeople()
    const coreCount = people.filter(p => p.isCore).length
    showBadge(`${people.length} members, ${coreCount} core`, 'ok')
    return { people }
  }

  return {}
}

// ── Entry point ───────────────────────────────────────────────────────────────

let lastHref = location.href
let running  = false

async function init() {
  if (running) return
  running = true
  try {
    // Give LinkedIn's SPA time to render (heavy React app, needs 3.5s minimum)
    await sleep(3500)

    let resp: { cmd: 'scrape' | 'ignore'; step?: LiScraperStep; companyName?: string } | null = null
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'LI_SCRAPER_READY',
        url:  location.href,
      })
    } catch {
      // Extension context invalid (SW restart race) — try once more after a pause
      await sleep(1500)
      try {
        resp = await chrome.runtime.sendMessage({ type: 'LI_SCRAPER_READY', url: location.href })
      } catch {
        return
      }
    }

    if (!resp || resp.cmd === 'ignore' || !resp.step) return

    const data = await scrape(resp.step, resp.companyName ?? '')
    showBadge('Sending data to LeadScout…')

    try {
      await chrome.runtime.sendMessage({
        type: 'LI_SCRAPER_DATA',
        step: resp.step,
        data,
        url:  location.href,
      })
      showBadge('Moving to next page…', 'ok')
    } catch {
      showBadge('Send failed — SW may have restarted', 'err')
    }
    removeBadge(2500)
  } finally {
    running = false
  }
}

// Show completion badge when SW signals scraping is complete. The tab itself
// is closed by the SERVICE WORKER via chrome.tabs.remove — window.close() here
// only works for script-opened windows and just logs "Scripts may close only
// the windows that were opened by them" on every completed scrape.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'LI_DONE') {
    showBadge('Scraping complete! Closing tab…', 'ok')
  }
})

// Handle LinkedIn SPA navigation (URL changes without full page reload)
new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href
    init()
  }
}).observe(document.body, { childList: true, subtree: true })

init()
