// Content-script based social media scraper.
// Opens hidden background tabs when the user is already logged in and scrapes
// publicly visible post content from LinkedIn, Twitter/X, and Instagram.
// Does NOT bypass login — requires the user's existing browser session.
// <all_urls> + scripting permissions are already in manifest.json.

export interface ScrapedPost {
  platform: 'linkedin' | 'twitter' | 'instagram' | 'facebook'
  date?: string
  text: string
  url?: string
}

export interface ScrapeProgress {
  step: 'searching' | 'scraping' | 'done' | 'login_required' | 'not_found'
  platform: 'linkedin' | 'twitter' | 'instagram' | 'facebook'
  personName?: string
  message: string
}

type ProgressFn = (p: ScrapeProgress) => void

// ─── Tab helpers ──────────────────────────────────────────────────────────────

const TAB_LOAD_TIMEOUT_MS    = 30000   // max wait for page 'complete' event
const RENDER_WAIT_MS         = 8000    // extra wait after 'complete' for JS to render content
// LinkedIn company page: randomized 15-25s render wait + human scroll — see fetchLinkedInHtml
const LINKEDIN_RENDER_MS_MIN = 15000
const LINKEDIN_RENDER_MS_MAX = 25000
// Activity scroll takes up to 30 scrolls × 2.5s = 75s + initial load.
// We use a separate longer timeout for activity pages.
const ACTIVITY_TAB_TIMEOUT_MS = 120000

// Kept for backward-compat export — actual LinkedIn visits use fetchLinkedInHtml
export const LINKEDIN_RENDER_MS = LINKEDIN_RENDER_MS_MIN

function openTab(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab.id) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'Tab creation failed'))
      } else {
        resolve(tab.id)
      }
    })
  })
}

function waitForLoad(tabId: number, timeoutMs = TAB_LOAD_TIMEOUT_MS, renderWaitMs = RENDER_WAIT_MS): Promise<void> {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, renderWaitMs)
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      done()
    }, timeoutMs)

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        done()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

function closeTab(tabId: number): Promise<void> {
  return chrome.tabs.remove(tabId).catch(() => {})
}

export async function runInTab<T>(
  url: string,
  // chrome.scripting awaits promise-returning injected functions, so async
  // scrapers (which poll for late-rendering content) are fully supported.
  injected: (...args: any[]) => T | Promise<T>,
  args: any[] = [],
  loadTimeoutMs = TAB_LOAD_TIMEOUT_MS,
  renderWaitMs  = RENDER_WAIT_MS,
): Promise<T | null> {
  let tabId: number | null = null
  try {
    tabId = await openTab(url)
    await waitForLoad(tabId, loadTimeoutMs, renderWaitMs)
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injected,
      args,
    })
    return (results[0]?.result as T) ?? null
  } catch {
    return null
  } finally {
    if (tabId !== null) await closeTab(tabId)
  }
}

// ─── Injected DOM scrapers (MUST be self-contained — no closure over outer scope) ─

function _linkedInSearch(args: { query: string }): Array<{
  name: string; title: string; secondary: string; profileUrl: string
}> {
  if (location.href.includes('/login') || location.href.includes('/authwall')) return []

  const results: Array<{ name: string; title: string; secondary: string; profileUrl: string }> = []

  document.querySelectorAll(
    '.reusable-search__result-container, li[data-occludable-entity-urn], .search-results-container li'
  ).forEach((item) => {
    const nameEl = item.querySelector(
      '.entity-result__title-text a span[aria-hidden="true"], ' +
      '.app-aware-link span[aria-hidden="true"]'
    ) as HTMLElement | null
    const name = nameEl?.innerText?.trim()
    if (!name) return

    const titleEl  = item.querySelector('.entity-result__primary-subtitle')   as HTMLElement | null
    const secondEl = item.querySelector('.entity-result__secondary-subtitle') as HTMLElement | null
    const linkEl   = item.querySelector('a[href*="/in/"]')                    as HTMLAnchorElement | null

    results.push({
      name,
      title:      titleEl?.innerText?.trim()  ?? '',
      secondary:  secondEl?.innerText?.trim() ?? '',
      profileUrl: linkEl?.href?.split('?')[0] ?? '',
    })
  })

  return results.slice(0, 5)
}

// Scrolls LinkedIn activity page and collects ALL posts from the last 6 months.
// Runs as an async function inside the LinkedIn tab — handles its own scroll loop.
async function _linkedInActivityScrollAll(): Promise<{
  loginRequired: boolean
  posts: Array<{ text: string; date: string | null; dateMs: number | null; url: string | null }>
}> {
  const href = location.href
  if (href.includes('/login') || href.includes('/authwall') || href.includes('/checkpoint')) {
    return { loginRequired: true, posts: [] }
  }

  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - SIX_MONTHS_MS

  // Parse LinkedIn timestamp → ms since epoch.
  // LinkedIn <time> elements have datetime="2025-01-15T10:30:00.000Z" (ISO) on the attribute,
  // but the visible text is relative ("2w", "3mo", "Jan 2025", etc.).
  // We prefer the datetime attribute — it's always the exact timestamp.
  function toMs(el: HTMLTimeElement | null): number | null {
    const attr = el?.getAttribute('datetime')
    if (attr) {
      const d = new Date(attr)
      if (!isNaN(d.getTime())) return d.getTime()
    }
    // Fallback: parse relative text like "2w ago", "3mo", "1yr"
    const txt = el?.innerText?.trim() ?? ''
    const m = txt.match(/^(\d+)\s*(s|m|h|d|w|mo|yr)/)
    if (m) {
      const n = parseInt(m[1])
      const units: Record<string, number> = {
        s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, yr: 31536e6,
      }
      return Date.now() - n * (units[m[2]] ?? 0)
    }
    return null
  }

  // Extract all visible posts from DOM at the current scroll position.
  function extractVisible() {
    const seen = new Set<string>()
    const out: Array<{ text: string; date: string | null; dateMs: number | null; url: string | null }> = []

    document.querySelectorAll(
      '.feed-shared-update-v2, [data-urn*="urn:li:activity"], .occludable-update'
    ).forEach((el) => {
      const textEl = el.querySelector(
        '.feed-shared-update-v2__description .break-words, ' +
        '.update-components-text .break-words, ' +
        '.feed-shared-text__text-view span[dir="ltr"], ' +
        '.attributed-text-segment-list__content'
      ) as HTMLElement | null

      const text = textEl?.innerText?.trim()
      if (!text || text.length < 15 || seen.has(text)) return
      seen.add(text)

      const timeEl = el.querySelector('time') as HTMLTimeElement | null
      const date   = timeEl?.getAttribute('datetime') ?? timeEl?.innerText?.trim() ?? null
      const dateMs = toMs(timeEl)

      const linkEl = el.querySelector(
        'a[href*="/posts/"], a[href*="ugcPost"], a[href*="/feed/update/"]'
      ) as HTMLAnchorElement | null

      out.push({ text: text.slice(0, 1200), date, dateMs, url: linkEl?.href ?? null })
    })
    return out
  }

  // Scroll loop: keep scrolling until oldest visible post is beyond 6 months,
  // or page stops loading new content (3 consecutive scrolls with no new posts).
  let lastCount = 0
  let staleRounds = 0
  const MAX_SCROLLS = 30  // safety cap (~60–90 seconds max)

  for (let i = 0; i < MAX_SCROLLS; i++) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    await new Promise(r => setTimeout(r, 2500))  // wait for LinkedIn to load next batch

    const posts = extractVisible()

    // Check if we've scrolled past 6 months
    const datedPosts = posts.filter(p => p.dateMs !== null)
    if (datedPosts.length > 0) {
      const oldestMs = Math.min(...datedPosts.map(p => p.dateMs!))
      if (oldestMs < cutoff) break  // found posts older than 6 months — stop
    }

    if (posts.length === lastCount) {
      staleRounds++
      if (staleRounds >= 3) break  // no new posts loading — end of feed
    } else {
      staleRounds = 0
      lastCount = posts.length
    }
  }

  // Final extraction — filter to posts within the last 6 months.
  // Posts with no date are included (can't know when they were posted).
  const all = extractVisible()
  const withinWindow = all.filter(p => p.dateMs === null || p.dateMs >= cutoff)

  return { loginRequired: false, posts: withinWindow }
}

// Scrolls Twitter/X profile and collects all tweets from last 6 months.
async function _twitterScrollAll(): Promise<{
  loginRequired: boolean
  posts: Array<{ text: string; date: string | null; dateMs: number | null; url: string | null }>
}> {
  const hasTweets = !!document.querySelector('[data-testid="tweet"]')
  const hasWall   = !!document.querySelector('[data-testid="loginButton"], [data-testid="signupButton"]')
  if (!hasTweets && hasWall) return { loginRequired: true, posts: [] }

  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - SIX_MONTHS_MS

  function extractTweets() {
    const seen = new Set<string>()
    const out: Array<{ text: string; date: string | null; dateMs: number | null; url: string | null }> = []

    document.querySelectorAll('[data-testid="tweet"]').forEach((tweet) => {
      const textEl = tweet.querySelector('[data-testid="tweetText"]') as HTMLElement | null
      const text   = textEl?.innerText?.trim()
      if (!text || text.length < 5 || seen.has(text)) return
      seen.add(text)

      const timeEl  = tweet.querySelector('time') as HTMLTimeElement | null
      const dateAttr = timeEl?.getAttribute('datetime') ?? null
      const dateMs   = dateAttr ? new Date(dateAttr).getTime() : null
      const linkEl   = tweet.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null

      out.push({ text: text.slice(0, 800), date: dateAttr, dateMs, url: linkEl?.href ?? null })
    })
    return out
  }

  let lastCount = 0
  let staleRounds = 0

  for (let i = 0; i < 25; i++) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    await new Promise(r => setTimeout(r, 2000))

    const tweets = extractTweets()
    const datedTweets = tweets.filter(t => t.dateMs !== null)
    if (datedTweets.length > 0) {
      const oldestMs = Math.min(...datedTweets.map(t => t.dateMs!))
      if (oldestMs < cutoff) break
    }

    if (tweets.length === lastCount) {
      staleRounds++
      if (staleRounds >= 3) break
    } else {
      staleRounds = 0
      lastCount = tweets.length
    }
  }

  const all = extractTweets()
  const withinWindow = all.filter(t => t.dateMs === null || t.dateMs >= cutoff)
  return { loginRequired: false, posts: withinWindow }
}

function _instagramScraper(): {
  loginRequired: boolean
  bio: string
  posts: Array<{ url: string; caption: string }>
} {
  if (location.href.includes('/accounts/login/')) return { loginRequired: true, bio: '', posts: [] }

  const bioEl = document.querySelector(
    'header section div span, ._ap3a._aaco._aacu, header span._ap3a'
  ) as HTMLElement | null

  const posts: Array<{ url: string; caption: string }> = []
  const seen = new Set<string>()

  document.querySelectorAll('a[href*="/p/"]').forEach((link) => {
    const url = (link as HTMLAnchorElement).href
    if (!url || seen.has(url)) return
    seen.add(url)
    const img     = link.querySelector('img')
    const caption = img?.getAttribute('alt') ?? ''
    posts.push({ url, caption: caption.slice(0, 300) })
  })

  return {
    loginRequired: false,
    bio:   bioEl?.innerText?.trim() ?? '',
    posts: posts.slice(0, 8),
  }
}

function _facebookScraper(): {
  loginRequired: boolean
  bio: string
  posts: Array<{ url: string; text: string }>
} {
  if (location.href.includes('/login')) return { loginRequired: true, bio: '', posts: [] }

  const bioEl = document.querySelector(
    '[data-pagelet="ProfileTilesFeed"] span, [data-pagelet="PageAbout"] span'
  ) as HTMLElement | null

  const posts: Array<{ url: string; text: string }> = []
  const seen = new Set<string>()

  document.querySelectorAll('[data-pagelet*="FeedUnit"], [role="article"]').forEach((el) => {
    const textEl = el.querySelector('[data-ad-preview="message"], [dir="auto"]') as HTMLElement | null
    const text   = textEl?.innerText?.trim()
    if (!text || text.length < 15 || seen.has(text)) return
    seen.add(text)

    const linkEl = el.querySelector('a[href*="/posts/"], a[href*="/permalink/"]') as HTMLAnchorElement | null
    posts.push({ url: linkEl?.href ?? '', text: text.slice(0, 600) })
  })

  return {
    loginRequired: false,
    bio:   bioEl?.innerText?.trim() ?? '',
    posts: posts.slice(0, 8),
  }
}

// ─── Generic rendered-HTML fetch ──────────────────────────────────────────────
// Opens a real (background) tab, waits for it to render, and returns the fully
// rendered outerHTML. Used to swap raw fetch() scraping (websiteFetcher.ts) for
// real-browser visits — avoids bot detection on Google/IndiaMART/JustDial/etc.
// and captures JS-rendered content that a plain fetch() would miss.

function _getOuterHtml(): string {
  return document.documentElement.outerHTML
}

// Injected into the LinkedIn tab: slowly scrolls through the page the way a
// human would read it, pauses at the bottom, scrolls back up a bit, then
// captures outerHTML. The scroll triggers LinkedIn's lazy loaders so the
// People section, About text, specialties, and recent posts are all in the DOM.
// Must be self-contained — no closure over outer scope.
async function _humanScrollThenGetHtml(): Promise<string> {
  const totalHeight = () => document.body.scrollHeight
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // Scroll down in 7–10 steps, pausing 1.3–2.3s between each (human reading pace)
  const steps = 7 + Math.floor(Math.random() * 4)
  for (let i = 1; i <= steps; i++) {
    const targetY = Math.floor((totalHeight() / steps) * i)
    window.scrollTo({ top: targetY, behavior: 'smooth' })
    await sleep(1300 + Math.random() * 1000)
  }

  // Pause at the bottom — like a human finishing the page
  await sleep(2000 + Math.random() * 2000)

  // Scroll back up to ~25% — natural re-read behaviour
  window.scrollTo({ top: Math.floor(totalHeight() * 0.25), behavior: 'smooth' })
  await sleep(1500 + Math.random() * 1000)

  return document.documentElement.outerHTML
}

// LinkedIn-specific tab fetch with full human-behaviour simulation:
//   1. Pre-open delay (2–6s) — humans don't click instantly
//   2. Wait for page 'complete' + randomised render wait (15–25s)
//   3. Human scroll (7–10 steps, ~14–26s) to trigger lazy-loaded content
//   4. Capture outerHTML
async function fetchLinkedInHtml(url: string): Promise<string | null> {
  // 1. Pre-open delay
  const preDelay = 2000 + Math.random() * 4000
  await new Promise<void>((r) => setTimeout(r, preDelay))

  let tabId: number | null = null
  try {
    tabId = await openTab(url)

    // 2. Wait for load + randomised render time
    const renderWait = LINKEDIN_RENDER_MS_MIN + Math.random() * (LINKEDIN_RENDER_MS_MAX - LINKEDIN_RENDER_MS_MIN)
    await waitForLoad(tabId, TAB_LOAD_TIMEOUT_MS, renderWait)

    // 3. Human scroll + capture (async injected function — Chrome MV3 supports this)
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: _humanScrollThenGetHtml,
      args: [],
    })

    return (results[0]?.result as string) ?? null
  } catch {
    return null
  } finally {
    if (tabId !== null) await closeTab(tabId)
  }
}

export async function fetchRenderedHtml(url: string, timeoutMs = TAB_LOAD_TIMEOUT_MS): Promise<string | null> {
  if (url.includes('linkedin.com')) return fetchLinkedInHtml(url)
  return runInTab(url, _getOuterHtml, [], timeoutMs, RENDER_WAIT_MS)
}

// ─── LinkedIn profile resolution ──────────────────────────────────────────────
// Extracts the /in/slug from a full LinkedIn profile URL

function slugFromLinkedIn(url: string): string {
  return url.replace(/\/$/, '').split('/in/')[1]?.split('/')[0] ?? ''
}

// Scores a LinkedIn search result against our target person.
// Returns 0 if the name clearly doesn't match (skip it), otherwise 0-100.
function matchScore(
  result: { name: string; title: string; secondary: string },
  personName: string,
  brandVariants: string[],
  city: string
): number {
  const n   = result.name.toLowerCase()
  const t   = result.title.toLowerCase()
  const s   = result.secondary.toLowerCase()
  const pn  = personName.toLowerCase()
  const c   = city.toLowerCase()

  // Name: at least 60% of name parts must appear in the result name
  const parts    = pn.split(' ').filter(x => x.length > 1)
  const matched  = parts.filter(p => n.includes(p))
  if (matched.length < Math.ceil(parts.length * 0.6)) return 0

  let score = (matched.length / parts.length) * 40

  // Company: any brand variant in title or secondary text
  if (brandVariants.some(v => t.includes(v.toLowerCase()) || s.includes(v.toLowerCase()))) {
    score += 40
  }

  // City match
  if (s.includes(c) || t.includes(c)) score += 20

  return score
}

async function resolveLinkedInUrl(
  personName: string,
  brandVariants: string[],
  city: string
): Promise<string | null> {
  const q   = encodeURIComponent(`${personName} ${brandVariants[0]} ${city}`)
  const url = `https://www.linkedin.com/search/results/people/?keywords=${q}`

  const rows = await runInTab(url, _linkedInSearch, [{ query: q }])
  if (!rows?.length) return null

  let best: { url: string; score: number } | null = null
  for (const row of rows) {
    const score = matchScore(row, personName, brandVariants, city)
    if (score > 0 && (!best || score > best.score)) {
      best = { url: row.profileUrl, score }
    }
  }

  // Require at least 40/100 confidence before trusting the match
  return best && best.score >= 40 ? best.url : null
}

// ─── LinkedIn company people page ────────────────────────────────────────────
// Scrapes linkedin.com/company/{slug}/people/ to get employee LinkedIn URLs.
// This is the primary way to resolve individual LinkedIn profiles — no search,
// no name ambiguity, direct URL from the company's own employee list.

function _linkedInCompanyPeople(): Array<{ name: string; title: string; profileUrl: string }> {
  if (location.href.includes('/login') || location.href.includes('/authwall')) return []

  const people: Array<{ name: string; title: string; profileUrl: string }> = []

  document.querySelectorAll(
    '.org-people-profile-card__profile-info, ' +
    '.artdeco-entity-lockup, ' +
    '[data-member-id], ' +
    '.org-people__profile-list-item'
  ).forEach((card) => {
    const nameEl = card.querySelector(
      '.org-people-profile-card__profile-title, ' +
      '.artdeco-entity-lockup__title span[aria-hidden="true"], ' +
      '.app-aware-link span[aria-hidden="true"]'
    ) as HTMLElement | null

    const titleEl = card.querySelector(
      '.org-people-profile-card__profile-position, ' +
      '.artdeco-entity-lockup__subtitle'
    ) as HTMLElement | null

    const linkEl = card.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null

    const name = nameEl?.innerText?.trim()
    if (!name || name.length < 2) return

    people.push({
      name,
      title:      titleEl?.innerText?.trim() ?? '',
      profileUrl: linkEl?.href?.split('?')[0] ?? '',
    })
  })

  return people
}

// Fuzzy name match — returns true if the two names refer to the same person.
// Handles "Rajesh Nema" matching "Rajesh Kumar Nema" or "R. Nema".
function namesMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, '').trim()
  const na = normalize(a).split(/\s+/).filter(p => p.length > 1)
  const nb = normalize(b).split(/\s+/).filter(p => p.length > 1)

  // Count how many parts of the shorter name appear in the longer name
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  const matched = shorter.filter(p => longer.includes(p))
  return matched.length >= Math.ceil(shorter.length * 0.7)
}

// Scrapes the company LinkedIn /people/ page once and returns the full
// name+title+profileUrl list — used both to resolve known team members'
// profile URLs and (when no decision maker was found in initial research)
// to pick one directly from the employee list.
export async function resolveCompanyPeopleDetailed(
  companyLinkedInUrl: string,
): Promise<Array<{ name: string; title: string; profileUrl: string }>> {
  const slug = companyLinkedInUrl.match(/\/company\/([^/?#]+)/)?.[1]
  if (!slug) return []

  const url = `https://www.linkedin.com/company/${slug}/people/`
  const people = await runInTab(url, _linkedInCompanyPeople)
  return people ?? []
}

// Resolves team member LinkedIn URLs from the company LinkedIn people page.
// Returns a map: personName → linkedInProfileUrl
export async function resolveTeamLinkedInFromCompany(
  companyLinkedInUrl: string,
): Promise<Map<string, string>> {
  const people = await resolveCompanyPeopleDetailed(companyLinkedInUrl)
  const result = new Map<string, string>()
  for (const p of people) {
    if (p.profileUrl) result.set(p.name, p.profileUrl)
  }
  return result
}

// Ranks a job title by seniority — used to auto-pick a decision maker when
// initial research found no named decision maker / team members at all.
function seniorityScore(title: string): number {
  const t = title.toLowerCase()
  const ranked: Array<[string, number]> = [
    ['founder', 100], ['co-founder', 100], ['cofounder', 100],
    ['ceo', 95], ['owner', 92], ['proprietor', 90],
    ['managing director', 90], [' md', 82], ['president', 80],
    ['cto', 75], ['coo', 75], ['cfo', 75], ['cmo', 70], ['chief', 68],
    ['executive director', 70], ['director', 65],
    ['partner', 60], ['principal', 55],
    ['head of', 50], ['head -', 50], ['head,', 50],
    ['vice president', 48], ['vp', 45], ['general manager', 45], ['gm', 40],
  ]
  let best = 0
  for (const [kw, score] of ranked) if (t.includes(kw)) best = Math.max(best, score)
  return best
}

// Picks the most senior person from a company's LinkedIn employee list to
// stand in as the decision maker when none was identified during research.
export function pickDecisionMaker(
  people: Array<{ name: string; title: string; profileUrl: string }>,
): { name: string; title: string; profileUrl: string } | null {
  const withUrl = people.filter(p => p.profileUrl)
  if (!withUrl.length) return null

  let best = withUrl[0]
  let bestScore = seniorityScore(best.title)
  for (const p of withUrl.slice(1)) {
    const score = seniorityScore(p.title)
    if (score > bestScore) { best = p; bestScore = score }
  }
  return best
}

// Match a known team member name against the scraped company employee map.
// Returns the LinkedIn URL if a confident match is found.
export function findPersonLinkedIn(
  personName: string,
  companyPeopleMap: Map<string, string>,
): string | undefined {
  for (const [scrapedName, url] of companyPeopleMap) {
    if (namesMatch(personName, scrapedName)) return url
  }
  return undefined
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scrapeLinkedInPerson(
  personName: string,
  brandVariants: string[],
  city: string,
  knownLinkedInUrl?: string,
  onProgress?: ProgressFn
): Promise<{ posts: ScrapedPost[]; resolvedProfileUrl?: string; loginRequired: boolean }> {
  onProgress?.({
    step: 'searching', platform: 'linkedin', personName,
    message: `Searching LinkedIn for ${personName}…`,
  })

  let profileUrl = knownLinkedInUrl

  if (!profileUrl) {
    profileUrl = await resolveLinkedInUrl(personName, brandVariants, city) ?? undefined
    if (!profileUrl) {
      onProgress?.({
        step: 'not_found', platform: 'linkedin', personName,
        message: `LinkedIn profile not found for ${personName}`,
      })
      return { posts: [], loginRequired: false }
    }
  }

  onProgress?.({
    step: 'scraping', platform: 'linkedin', personName,
    message: `Scraping LinkedIn posts for ${personName} (scrolling 6-month history…)`,
  })

  const slug        = slugFromLinkedIn(profileUrl)
  const activityUrl = `https://www.linkedin.com/in/${slug}/recent-activity/all/`

  // Use extended timeout — scrolling through 6 months takes up to 2 min
  const raw = await runInTab(
    activityUrl,
    _linkedInActivityScrollAll,
    [],
    ACTIVITY_TAB_TIMEOUT_MS,
  )

  if (!raw) return { posts: [], resolvedProfileUrl: profileUrl, loginRequired: false }

  if (raw.loginRequired) {
    onProgress?.({
      step: 'login_required', platform: 'linkedin', personName,
      message: 'LinkedIn: please log in to your LinkedIn account in this browser',
    })
    return { posts: [], resolvedProfileUrl: profileUrl, loginRequired: true }
  }

  const posts: ScrapedPost[] = raw.posts.map((p: any) => ({
    platform: 'linkedin' as const,
    date:     p.date ?? undefined,
    text:     p.text,
    url:      p.url ?? undefined,
  }))

  onProgress?.({
    step: 'done', platform: 'linkedin', personName,
    message: `Found ${posts.length} posts for ${personName} (last 6 months)`,
  })

  return { posts, resolvedProfileUrl: profileUrl, loginRequired: false }
}

export async function scrapeTwitterProfile(
  twitterUrl: string,
  label: string,
  onProgress?: ProgressFn
): Promise<{ posts: ScrapedPost[]; loginRequired: boolean }> {
  onProgress?.({
    step: 'scraping', platform: 'twitter',
    message: `Scraping Twitter/X for ${label}…`,
  })

  const url = twitterUrl.replace('twitter.com', 'x.com').replace(/\/$/, '')
  const raw = await runInTab(url, _twitterScrollAll, [], ACTIVITY_TAB_TIMEOUT_MS)

  if (!raw) return { posts: [], loginRequired: false }

  if (raw.loginRequired) {
    onProgress?.({
      step: 'login_required', platform: 'twitter',
      message: 'Twitter/X: please log in to see more posts',
    })
    return { posts: [], loginRequired: true }
  }

  const posts: ScrapedPost[] = raw.posts.map(p => ({
    platform: 'twitter' as const,
    date:     p.date ?? undefined,
    text:     p.text,
    url:      p.url ?? undefined,
  }))

  onProgress?.({
    step: 'done', platform: 'twitter',
    message: `Found ${posts.length} tweets for ${label} (last 6 months)`,
  })

  return { posts, loginRequired: false }
}

export async function scrapeInstagramProfile(
  instagramUrl: string,
  label: string,
  onProgress?: ProgressFn
): Promise<{ posts: ScrapedPost[]; bio?: string; loginRequired: boolean }> {
  onProgress?.({
    step: 'scraping', platform: 'instagram',
    message: `Scraping Instagram for ${label}…`,
  })

  const url = instagramUrl.replace(/\/$/, '') + '/'
  const raw = await runInTab(url, _instagramScraper)

  if (!raw) return { posts: [], loginRequired: false }

  if (raw.loginRequired) {
    onProgress?.({
      step: 'login_required', platform: 'instagram',
      message: 'Instagram: please log in to see posts',
    })
    return { posts: [], loginRequired: true }
  }

  const posts: ScrapedPost[] = raw.posts.map(p => ({
    platform: 'instagram' as const,
    text:     p.caption || '[post]',
    url:      p.url,
  }))

  onProgress?.({
    step: 'done', platform: 'instagram',
    message: `Found ${posts.length} Instagram posts for ${label}`,
  })

  return { posts, bio: raw.bio || undefined, loginRequired: false }
}

export async function scrapeFacebookProfile(
  facebookUrl: string,
  label: string,
  onProgress?: ProgressFn
): Promise<{ posts: ScrapedPost[]; bio?: string; loginRequired: boolean }> {
  onProgress?.({
    step: 'scraping', platform: 'facebook',
    message: `Scraping Facebook for ${label}…`,
  })

  const url = facebookUrl.replace(/\/$/, '') + '/'
  const raw = await runInTab(url, _facebookScraper)

  if (!raw) return { posts: [], loginRequired: false }

  if (raw.loginRequired) {
    onProgress?.({
      step: 'login_required', platform: 'facebook',
      message: 'Facebook: please log in to see posts',
    })
    return { posts: [], loginRequired: true }
  }

  const posts: ScrapedPost[] = raw.posts.map(p => ({
    platform: 'facebook' as const,
    text:     p.text || '[post]',
    url:      p.url || undefined,
  }))

  onProgress?.({
    step: 'done', platform: 'facebook',
    message: `Found ${posts.length} Facebook posts for ${label}`,
  })

  return { posts, bio: raw.bio || undefined, loginRequired: false }
}
