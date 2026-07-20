// LinkedIn Scraper — job lifecycle manager (runs in service worker)
// Active job is persisted in chrome.storage.local so it survives SW restarts.

import type {
  LinkedInScraperJob,
  LinkedInPost,
  LinkedInPerson,
  LinkedInPersonResult,
  LinkedInCompanyProfile,
  LiScraperStep,
} from '@/types/linkedinData'

const JOB_KEY = 'li_scraper_job'

// ── Storage helpers ───────────────────────────────────────────────────────────

export async function getLiJob(): Promise<LinkedInScraperJob | null> {
  const data = await chrome.storage.local.get(JOB_KEY)
  return (data[JOB_KEY] as LinkedInScraperJob) ?? null
}

async function saveLiJob(job: LinkedInScraperJob): Promise<void> {
  await chrome.storage.local.set({ [JOB_KEY]: job })
}

export async function clearLiJob(): Promise<void> {
  await chrome.storage.local.remove(JOB_KEY)
}

// ── URL utilities ─────────────────────────────────────────────────────────────

/** Extract slug from a LinkedIn company URL */
export function liCompanySlug(url: string): string {
  return url.match(/\/company\/([^/?#]+)/)?.[1] ?? ''
}

/** Normalise to https://www.linkedin.com/company/SLUG/ */
export function normaliseCompanyUrl(url: string): string {
  const slug = liCompanySlug(url)
  return slug ? `https://www.linkedin.com/company/${slug}/` : url
}

/** URL the scraper tab should be on for the current step */
export function stepUrl(job: LinkedInScraperJob): string {
  const base = job.companyLinkedInUrl
  switch (job.step) {
    case 'company-profile':
      return `${base}about/`
    case 'company-posts':
      return `${base}posts/`
    case 'company-people':
      return `${base}people/`
    case 'person-posts': {
      const p = job.corePersons[job.currentPersonIndex]
      return p?.activityUrl ?? ''
    }
    default:
      return ''
  }
}

/** True if the given URL corresponds to the job's current expected page */
export function urlMatchesStep(url: string, job: LinkedInScraperJob): boolean {
  const expected = stepUrl(job)
  if (!expected) return false
  const norm = (u: string) => u.split('?')[0].replace(/\/$/, '').toLowerCase()
  const normUrl = norm(url)
  const normExp = norm(expected).replace('https://www.linkedin.com', '')

  // For person-posts steps, match any recent-activity subpath (LinkedIn may redirect /shares/ ↔ /all/)
  if (job.step === 'person-posts') {
    const person = job.corePersons[job.currentPersonIndex]
    if (person?.profileUrl) {
      const usernameMatch = person.profileUrl.match(/\/in\/([^/?#]+)/)
      if (usernameMatch) {
        return normUrl.includes(`/in/${usernameMatch[1]}/recent-activity`)
      }
    }
  }

  return normUrl.includes(normExp)
}

// ── Job creation ──────────────────────────────────────────────────────────────

export async function startLiScraperJob(
  leadId: number,
  companyName: string,
  companyLinkedInUrl: string,
  mssqlId?: string,
): Promise<LinkedInScraperJob> {
  const job: LinkedInScraperJob = {
    id:                 crypto.randomUUID(),
    leadId,
    mssqlId,
    companyName,
    companyLinkedInUrl: normaliseCompanyUrl(companyLinkedInUrl),
    status:             'running',
    step:               'company-profile',
    tabId:              null,
    companyProfile:     null,
    companyPosts:       [],
    teamMembers:        [],
    personResults:      [],
    corePersons:        [],
    currentPersonIndex: 0,
    startedAt:          new Date().toISOString(),
    log:                [`[${ts()}] Job started for "${companyName}"`],
  }
  await saveLiJob(job)
  return job
}

// ── Data ingestion (called per scraper step) ──────────────────────────────────

export interface ScraperStepData {
  posts?: LinkedInPost[]
  people?: LinkedInPerson[]
  profile?: LinkedInCompanyProfile
  /** Set when the tab hit a login/captcha/paywall/checkpoint page — this step's data is unavailable */
  loginRequired?: boolean
}

/** Returns the next URL the scraper tab should navigate to (null = done) */
export async function ingestStepData(
  step: LiScraperStep,
  data: ScraperStepData,
): Promise<{ nextUrl: string | null; job: LinkedInScraperJob }> {
  const job = await getLiJob()
  if (!job) throw new Error('No active LinkedIn scraper job')

  const addLog = (msg: string) => job.log.push(`[${ts()}] ${msg}`)

  if (data.loginRequired) {
    addLog(`${step}: login/checkpoint page encountered — not bypassed, data marked unavailable`)
  }

  switch (step) {
    case 'company-profile': {
      job.companyProfile = data.profile ?? null
      addLog(data.profile ? `Company profile captured (industry: ${data.profile.industry})` : 'Company profile: Not Available')
      job.step = 'company-posts'
      break
    }

    case 'company-posts': {
      job.companyPosts = data.posts ?? []
      const recent = job.companyPosts.filter(p => p.withinSixMonths).length
      addLog(`Company posts: ${job.companyPosts.length} total, ${recent} in last 6 months`)
      job.step = 'company-people'
      break
    }

    case 'company-people': {
      job.teamMembers = data.people ?? []
      job.corePersons = job.teamMembers.filter(p => p.isCore && p.activityUrl)
      job.currentPersonIndex = 0
      addLog(`Team: ${job.teamMembers.length} members, ${job.corePersons.length} core (will visit their posts)`)
      job.step = job.corePersons.length > 0 ? 'person-posts' : 'done'
      break
    }

    case 'person-posts': {
      const person = job.corePersons[job.currentPersonIndex]
      if (person) {
        const result: LinkedInPersonResult = { person, posts: data.posts ?? [] }
        job.personResults.push(result)
        addLog(`${person.name} (${person.title}): ${result.posts.length} posts`)
      }
      job.currentPersonIndex++
      if (job.currentPersonIndex >= job.corePersons.length) {
        job.step = 'done'
      }
      break
    }
  }

  if (job.step === 'done') {
    job.status = 'done'
    job.completedAt = new Date().toISOString()
    addLog('Scraping complete ✓')
    await saveLiJob(job)
    // Remember this page as scraped so other leads matching the same company
    // page don't queue a duplicate scrape for the next 7 days.
    await markSlugScraped(job.companyLinkedInUrl).catch(() => {})
    return { nextUrl: null, job }
  }

  const nextUrl = stepUrl(job)
  await saveLiJob(job)
  return { nextUrl, job }
}

export async function cancelLiJob(): Promise<void> {
  const job = await getLiJob()
  if (job?.tabId) {
    // chrome.tabs.remove() is promise-based in MV3 — a synchronous try/catch
    // does NOT catch its rejection (e.g. "No tab with id" if already closed).
    await chrome.tabs.remove(job.tabId).catch(() => { /* tab may already be closed */ })
  }
  // A cancelled job usually means the page got stuck (authwall, layout change,
  // closed tab). Mark it scraped anyway — retrying the same broken page for
  // every other lead that matched it would loop the queue on one URL forever.
  if (job?.companyLinkedInUrl) {
    await markSlugScraped(job.companyLinkedInUrl).catch(() => {})
  }
  await clearLiJob()
}

// ── Auto-scrape queue ─────────────────────────────────────────────────────────
// Research jobs that discover a LinkedIn company URL enqueue it here; the
// service worker drains the queue one company at a time (deep 6-month scrape:
// company profile → posts → people → each core member's activity).

const QUEUE_KEY = 'li_scrape_queue'

export interface LiScrapeQueueItem {
  leadId: number
  companyName: string
  linkedInUrl: string
  mssqlId?: string
  enqueuedAt: string
}

// Registry of company slugs already deep-scraped (or cancelled after getting
// stuck) — the same LinkedIn page must not be re-scraped every time another
// lead's research surfaces it. Without this, one popular page that ranks for
// many small companies' queries gets opened again and again, blocking the
// research queue behind duplicate scrapes.
const SCRAPED_KEY = 'li_scraped_slugs'
const RESCRAPE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

export async function markSlugScraped(companyUrl: string): Promise<void> {
  const slug = liCompanySlug(companyUrl).toLowerCase()
  if (!slug) return
  const data = await chrome.storage.local.get(SCRAPED_KEY)
  const reg = (data[SCRAPED_KEY] as Record<string, string>) ?? {}
  reg[slug] = new Date().toISOString()
  await chrome.storage.local.set({ [SCRAPED_KEY]: reg })
}

async function isSlugRecentlyScraped(companyUrl: string): Promise<boolean> {
  const slug = liCompanySlug(companyUrl).toLowerCase()
  if (!slug) return false
  const data = await chrome.storage.local.get(SCRAPED_KEY)
  const reg = (data[SCRAPED_KEY] as Record<string, string>) ?? {}
  const last = reg[slug]
  return !!last && (Date.now() - new Date(last).getTime()) < RESCRAPE_COOLDOWN_MS
}

export async function enqueueLiScrape(item: Omit<LiScrapeQueueItem, 'enqueuedAt'>): Promise<void> {
  const slug = liCompanySlug(item.linkedInUrl).toLowerCase()
  if (!slug) return

  const data = await chrome.storage.local.get(QUEUE_KEY)
  const queue = (data[QUEUE_KEY] as LiScrapeQueueItem[]) ?? []

  // Skip if this lead is already queued — or if the SAME company page is
  // already queued under a different lead (dedup by URL slug, not just lead).
  if (queue.some((q) => q.leadId === item.leadId || liCompanySlug(q.linkedInUrl).toLowerCase() === slug)) return

  // Skip if this page was already scraped (or cancelled as stuck) recently.
  if (await isSlugRecentlyScraped(item.linkedInUrl)) {
    console.log(`[li-queue] ⏭ Skipping "${item.companyName}" — ${slug} already scraped recently`)
    return
  }

  queue.push({ ...item, enqueuedAt: new Date().toISOString() })
  await chrome.storage.local.set({ [QUEUE_KEY]: queue })
  console.log(`[li-queue] ➕ Queued LinkedIn deep-scrape for "${item.companyName}" (${queue.length} in queue)`)
}

export async function dequeueLiScrape(): Promise<LiScrapeQueueItem | null> {
  const data = await chrome.storage.local.get(QUEUE_KEY)
  const queue = (data[QUEUE_KEY] as LiScrapeQueueItem[]) ?? []
  // Drain past entries whose page was already scraped/cancelled — the queue
  // may still hold duplicates enqueued before URL-level dedup existed.
  let next: LiScrapeQueueItem | null = null
  while (queue.length > 0) {
    const candidate = queue.shift()!
    if (await isSlugRecentlyScraped(candidate.linkedInUrl)) {
      console.log(`[li-queue] ⏭ Dropping queued duplicate: "${candidate.companyName}" (page already scraped)`)
      continue
    }
    next = candidate
    break
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: queue })
  return next
}

export async function liScrapeQueueLength(): Promise<number> {
  const data = await chrome.storage.local.get(QUEUE_KEY)
  return ((data[QUEUE_KEY] as LiScrapeQueueItem[]) ?? []).length
}

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { hour12: false })
}
