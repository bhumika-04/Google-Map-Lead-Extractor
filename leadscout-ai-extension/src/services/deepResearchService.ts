// Social Intelligence — deep research on key people and company social activity.
//
// PRIMARY: Content script scraper (opens hidden tabs, uses user's logged-in session)
//   → LinkedIn posts (person level), Twitter/X posts (company), Instagram (company)
//
// FALLBACK: Google Search with date filter (finds indexed news, web mentions)
//   → Used for company-level news and when content scraping finds nothing
//
// Brand alias resolution happens BEFORE any search:
//   "Pragati Graphics and Packaging Pvt Ltd" → pragatiglobal.com → "Pragati Global"
//   This ensures LinkedIn search finds "Rajesh Nema at Pragati Global" correctly.

import type { ResearchResult } from '@/types/research'
import type { Lead } from '@/types/lead'
import type { DeepResearch, SocialPost, PersonActivity } from '@/types/deepResearch'
import { nowISO } from '@/utils/date'
import {
  scrapeLinkedInPerson,
  scrapeTwitterProfile,
  scrapeInstagramProfile,
  scrapeFacebookProfile,
  resolveCompanyPeopleDetailed,
  findPersonLinkedIn,
  pickDecisionMaker,
  type ScrapeProgress,
} from './socialScraper'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const FETCH_TIMEOUT = 10000

// Google date filter: "after:YYYY-MM-DD" for the last 6 months
function sixMonthsAgoFilter(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 6)
  return `after:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

async function googleSearch(query: string): Promise<string> {
  const url = `https://www.google.com/search?num=10&hl=en&gl=in&q=${encodeURIComponent(query)}`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    })
    clearTimeout(t)
    if (!res.ok) return ''
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<h3[^>]*>/gi, '\n##TITLE## ')
      .replace(/<\/h3>/gi, '\n')
      .replace(/<a[^>]+href="([^"]+)"[^>]*>/gi, (_, href) => {
        const m = href.match(/[?&]q=(https?[^&"]+)/)
        return `[LINK:${m ? decodeURIComponent(m[1]) : href}] `
      })
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 3000)
  } catch {
    return ''
  }
}

// Detect what platform a URL/snippet belongs to
function detectPlatform(text: string): SocialPost['platform'] {
  if (text.includes('linkedin.com'))  return 'linkedin'
  if (text.includes('twitter.com') || text.includes('x.com')) return 'twitter'
  if (text.includes('facebook.com')) return 'facebook'
  if (text.includes('instagram.com')) return 'instagram'
  if (text.includes('youtube.com'))  return 'youtube'
  if (text.includes('news') || text.includes('times') || text.includes('hindu') ||
      text.includes('livemint') || text.includes('economic')) return 'news'
  return 'web'
}

// ─── Brand alias resolution ───────────────────────────────────────────────────
// Companies often operate under a brand name different from their legal name.
// "Pragati Graphics and Packaging Pvt Ltd" → website is "pragatiglobal.com" → brand "Pragati Global"
// "Gupta Publishing House Pvt Ltd"         → website is "gphbooks.com"       → brand "GPH Books"
//
// We resolve this using signals already extracted during research:
//   1. Company LinkedIn slug    e.g. linkedin.com/company/pragati-global → "pragati-global"
//   2. Website domain           e.g. pragatiglobal.com → first word "pragati"
//   3. Website title (fetched)  e.g. "Pragati Global - Packaging" → "Pragati Global"
//
// The result is a list of name variants to use in person searches.

function extractBrandVariants(
  legalName: string,
  websiteUrl?: string,
  linkedInUrl?: string,
): string[] {
  const variants = new Set<string>()

  // Legal name: first meaningful word(s) e.g. "Pragati", "Gupta Publishing House"
  const legalWords = legalName
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|co)\b\.?/gi, '')
    .trim()
  variants.add(legalWords)

  // First word of legal name (most stable part) e.g. "Pragati", "Gupta"
  const firstWord = legalWords.split(/\s+/)[0]
  if (firstWord.length > 3) variants.add(firstWord)

  // From website URL: domain without TLD e.g. "pragatiglobal" → "Pragati Global"
  if (websiteUrl) {
    try {
      const domain = new URL(websiteUrl).hostname
        .replace(/^www\./, '')
        .replace(/\.(com|in|net|org|co\.in)$/, '')
      // Insert space before capital letters or split camelCase-ish domains
      const readable = domain
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[-_]/g, ' ')
      if (readable.length > 3 && readable !== firstWord.toLowerCase()) {
        variants.add(readable)  // e.g. "pragatiglobal" → keep as-is for search
        // Also the first word of domain: "pragati" from "pragatiglobal"
        const domainFirst = domain.split(/[-_]/)[0]
        if (domainFirst.length > 3) variants.add(domainFirst)
      }
    } catch { /* ignore bad URL */ }
  }

  // From LinkedIn company URL: slug e.g. /company/pragati-global → "pragati global"
  if (linkedInUrl) {
    const m = linkedInUrl.match(/\/company\/([^/?#]+)/)
    if (m) {
      const slug = m[1].replace(/-/g, ' ')
      variants.add(slug)  // e.g. "pragati global"
    }
  }

  return [...variants].filter(v => v.length > 2).slice(0, 4)
}

// Build a Google query that handles brand aliases.
// Uses OR across all known name variants so we catch profiles regardless of
// which version of the company name the person uses on LinkedIn.
function buildPersonQuery(
  personName: string,
  brandVariants: string[],
  city: string,
  role: string,
  industry: string,
  suffix: string = ''
): string {
  // Combine: person name + (company variant1 OR variant2) + city + role
  const companyClause = brandVariants.length === 1
    ? `"${brandVariants[0]}"`
    : `(${brandVariants.map(v => `"${v}"`).join(' OR ')})`

  const roleKeyword = role.toLowerCase().includes('director') ? 'Director'
    : role.toLowerCase().includes('ceo') ? 'CEO'
    : role.toLowerCase().includes('founder') ? 'Founder'
    : role.toLowerCase().includes('owner') ? 'Owner'
    : role.split(' ')[0]

  return `"${personName}" ${companyClause} "${city}" ${roleKeyword} ${suffix}`.trim()
}

// Explores ALL channels for one person at once — LinkedIn, web/news, Instagram,
// Facebook — before the caller moves on to the next person. Runs in parallel
// (Promise.all) rather than sequentially so a single person's full footprint
// is gathered in one pass.
async function fetchPersonActivity(
  name: string,
  role: string,
  industry: string,
  city: string,
  brandVariants: string[],
  personLinkedIn?: string,
  onProgress?: (p: ScrapeProgress) => void,
): Promise<{ rawText: string; resolvedLinkedInUrl?: string }> {
  const dateFilter = sixMonthsAgoFilter()
  const baseQuery  = buildPersonQuery(name, brandVariants, city, role, industry)

  const [liResult, webNews, instagramHits, facebookHits] = await Promise.all([
    // PRIMARY: Content script — opens LinkedIn tab, scrapes real posts
    scrapeLinkedInPerson(name, brandVariants, city, personLinkedIn, onProgress),
    // Web & news mentions (supplements even when LinkedIn worked)
    googleSearch(`${baseQuery} ${dateFilter}`),
    // Personal Instagram presence — we don't have a known profile URL for
    // individuals, so this is a targeted Google site-search
    googleSearch(`${baseQuery} site:instagram.com`),
    // Personal Facebook presence — same approach
    googleSearch(`${baseQuery} site:facebook.com`),
  ])

  const parts: string[] = []

  if (liResult.posts.length > 0) {
    const postLines = liResult.posts.map((p, i) =>
      `Post ${i + 1}${p.date ? ` (${p.date})` : ''}:\n${p.text}${p.url ? `\nURL: ${p.url}` : ''}`
    ).join('\n\n')
    parts.push(`=== LinkedIn posts for ${name} (live scrape) ===\n${postLines}`)
  }

  if (webNews) {
    parts.push(`=== Web & news mentions (Google) ===\nQuery: ${baseQuery} ${dateFilter}\n${webNews}`)
  }

  if (instagramHits) {
    parts.push(`=== Instagram mentions (Google site-search) ===\n${instagramHits}`)
  }

  if (facebookHits) {
    parts.push(`=== Facebook mentions (Google site-search) ===\n${facebookHits}`)
  }

  return {
    rawText: parts.join('\n\n'),
    resolvedLinkedInUrl: liResult.resolvedProfileUrl,
  }
}

async function fetchCompanyActivity(
  legalName: string,
  brandVariants: string[],
  city: string,
  socialUrls: { linkedIn?: string; facebook?: string; instagram?: string; youtube?: string; twitter?: string },
  onProgress?: (p: ScrapeProgress) => void,
): Promise<string> {
  const dateFilter = sixMonthsAgoFilter()
  const parts: string[] = []

  const primaryBrand = brandVariants[0] ?? legalName
  const allBrands = brandVariants.length > 1
    ? `(${brandVariants.map(v => `"${v}"`).join(' OR ')})`
    : `"${primaryBrand}"`

  // Google Search: company news + hiring signals (works without login)
  const [news, hiring] = await Promise.all([
    googleSearch(`${allBrands} "${city}" news OR announcement OR award ${dateFilter}`),
    googleSearch(`${allBrands} hiring OR "job opening" OR recruitment OR vacancy ${dateFilter}`),
  ])

  if (news)   parts.push(`=== Company news & announcements ===\n${news}`)
  if (hiring) parts.push(`=== Hiring & expansion signals ===\n${hiring}`)

  // PRIMARY: Content script — scrape Twitter/X company profile if URL known
  if (socialUrls.twitter) {
    const twResult = await scrapeTwitterProfile(socialUrls.twitter, primaryBrand, onProgress)
    if (twResult.posts.length > 0) {
      const lines = twResult.posts.map((p, i) =>
        `Tweet ${i + 1}${p.date ? ` (${p.date})` : ''}:\n${p.text}${p.url ? `\nURL: ${p.url}` : ''}`
      ).join('\n\n')
      parts.push(`=== Company Twitter/X posts (live) ===\n${lines}`)
    }
  }

  // PRIMARY: Content script — scrape Instagram company profile if URL known
  if (socialUrls.instagram) {
    const igResult = await scrapeInstagramProfile(socialUrls.instagram, primaryBrand, onProgress)
    if (igResult.bio) parts.push(`=== Instagram bio ===\n${igResult.bio}`)
    if (igResult.posts.length > 0) {
      const lines = igResult.posts.map((p, i) =>
        `Post ${i + 1}: ${p.text}${p.url ? `\nURL: ${p.url}` : ''}`
      ).join('\n\n')
      parts.push(`=== Company Instagram posts (live) ===\n${lines}`)
    }
  }

  // PRIMARY: Content script — scrape Facebook company page if URL known
  if (socialUrls.facebook) {
    const fbResult = await scrapeFacebookProfile(socialUrls.facebook, primaryBrand, onProgress)
    if (fbResult.bio) parts.push(`=== Facebook bio ===\n${fbResult.bio}`)
    if (fbResult.posts.length > 0) {
      const lines = fbResult.posts.map((p, i) =>
        `Post ${i + 1}: ${p.text}${p.url ? `\nURL: ${p.url}` : ''}`
      ).join('\n\n')
      parts.push(`=== Company Facebook posts (live) ===\n${lines}`)
    }
  }

  // List known social profiles so AI knows what channels the company uses
  const knownProfiles = Object.entries(socialUrls)
    .filter(([, url]) => url)
    .map(([platform, url]) => `  ${platform}: ${url}`)
    .join('\n')
  if (knownProfiles) {
    parts.push(`=== Company social profiles ===\n${knownProfiles}`)
  }

  return parts.join('\n\n')
}

// ─── AI Analysis ─────────────────────────────────────────────────────────────

function buildDeepResearchPrompt(
  companyName: string,
  industry: string,
  city: string,
  teamMembers: { name: string; role: string }[],
  peopleActivity: { name: string; role: string; raw: string }[],
  companyActivity: string
): string {
  const peopleSection = peopleActivity.map(p =>
    `Person: ${p.name} (${p.role})\n${p.raw || 'No activity found in last 6 months'}`
  ).join('\n\n---\n\n')

  return `You are a B2B sales intelligence expert. Analyze the recent social media and web activity data below for key people at a target company. Extract intelligence to help a salesperson approach this company.

COMPANY: ${companyName}
INDUSTRY: ${industry}
CITY: ${city}

KEY PEOPLE AT THIS COMPANY:
${teamMembers.map(m => `- ${m.name} (${m.role})`).join('\n')}

ACTIVITY DATA (last 6 months from Google Search, LinkedIn, Twitter, news):

${peopleSection}

COMPANY-LEVEL ACTIVITY:
${companyActivity || 'No recent company activity found'}

Analyze ALL the above data carefully. Extract:
1. What topics does each person post/talk about publicly?
2. Any mentions of: business challenges, technology changes, growth plans, partnerships, events attended, awards
3. Company-level signals: hiring sprees, new clients, expansion, software/ERP changes, pain points
4. The best personalized opening line to reach out to the decision maker

Return ONLY valid JSON (no markdown, no code blocks):
{
  "peopleInsights": [
    {
      "name": "exact name from team list",
      "role": "their role",
      "topics": ["topic1", "topic2", "topic3"],
      "recentPosts": [
        {
          "platform": "linkedin|twitter|facebook|news|web",
          "date": "approximate date if visible e.g. Jan 2025, or null",
          "headline": "post title or article headline if available, else null",
          "snippet": "exact snippet or quote from the post/article (max 150 chars)",
          "url": "URL if found, else null"
        }
      ],
      "activitySummary": "2-3 sentences summarizing what this person is publicly active about",
      "bestApproach": "How to personalize your outreach for this specific person — what to reference"
    }
  ],
  "companySignals": [
    "e.g. Posted about winning a new pharma client in March 2025",
    "e.g. Exhibiting at PackagingIndia 2025 (mentioned in March post)"
  ],
  "intentSignals": [
    "e.g. Hiring ERP consultant on LinkedIn (signals technology upgrade in progress)",
    "e.g. CEO posted about manual reporting being a bottleneck (Jan 2025)"
  ],
  "recommendedPitch": "2-3 sentences: the best angle to pitch based on what you found. Be specific about what signal to reference.",
  "pitchTemplate": "A ready-to-send 3-4 line cold outreach message referencing real activity. Use [Your Name] and [Your Product] as placeholders."
}`
}

async function callOpenAI(prompt: string, apiKey: string, model: string): Promise<any> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('AI returned no JSON')
  return JSON.parse(m[0])
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runDeepResearch(
  result: ResearchResult,
  lead: Lead,
  apiKey: string,
  model: string,
  onProgress?: (message: string) => void,
): Promise<DeepResearch> {
  const teamMembers = result.teamMembers ?? []

  // Resolve brand name aliases BEFORE any person/company searches.
  // "Pragati Graphics and Packaging Pvt Ltd" → pragatiglobal.com → "Pragati Global"
  // "Gupta Publishing House" → gphbooks.com → "GPH Books"
  const brandVariants = extractBrandVariants(
    lead.companyName,
    result.website ?? lead.website ?? undefined,
    result.linkedIn ?? undefined,
  )

  const socialUrls = {
    linkedIn:  result.linkedIn  ?? undefined,
    facebook:  result.facebook  ?? undefined,
    instagram: result.instagram ?? undefined,
    youtube:   result.youtube   ?? undefined,
    twitter:   result.twitter   ?? undefined,
  }

  const industry = result.industry ?? lead.keyword ?? ''

  const progressFn = (p: ScrapeProgress) => onProgress?.(p.message)

  // If only decisionMaker, add them as the sole person to research
  const people: { name: string; role: string; linkedInUrl?: string }[] = teamMembers.length > 0
    ? teamMembers.map(m => ({ ...m, linkedInUrl: undefined }))
    : result.decisionMaker
      ? [{ name: result.decisionMaker, role: 'Decision Maker', linkedInUrl: result.decisionMakerLinkedIn }]
      : []

  onProgress?.(`Resolved brand: ${brandVariants[0]} (${brandVariants.length} variants)`)

  // STEP 1: Scrape the company LinkedIn /people/ page to get individual profile URLs.
  // This is the most reliable way to resolve team member LinkedIn profiles —
  // avoids ambiguity entirely because everyone on that page works at this company.
  let companyPeopleDetailed: Array<{ name: string; title: string; profileUrl: string }> = []
  const companyPeopleMap = new Map<string, string>()
  if (socialUrls.linkedIn) {
    onProgress?.(`Loading ${brandVariants[0]} LinkedIn employee list…`)
    companyPeopleDetailed = await resolveCompanyPeopleDetailed(socialUrls.linkedIn)
    for (const p of companyPeopleDetailed) {
      if (p.profileUrl) companyPeopleMap.set(p.name, p.profileUrl)
    }
    if (companyPeopleMap.size > 0) {
      onProgress?.(`Found ${companyPeopleMap.size} employees on LinkedIn company page`)
    }
  }

  // FALLBACK: No decision maker / team members surfaced during initial research —
  // pick the most senior person straight off the company's LinkedIn employee list
  // (founder/CEO/MD/owner/director, in that priority order) so research still
  // has someone to investigate.
  if (people.length === 0 && companyPeopleDetailed.length > 0) {
    const picked = pickDecisionMaker(companyPeopleDetailed)
    if (picked) {
      onProgress?.(`No decision maker from research — using ${picked.name} (${picked.title || 'employee'}) from LinkedIn company page`)
      people.push({ name: picked.name, role: picked.title || 'Decision Maker', linkedInUrl: picked.profileUrl })
    }
  }

  // STEP 2: Fetch each person's LinkedIn activity + web mentions
  // Uses direct URL from company people page when available; falls back to search otherwise.
  const peopleWithActivity: { name: string; role: string; linkedInUrl?: string; raw: string }[] = []
  for (const p of people.slice(0, 5)) {
    // Priority: company people page match > known URL from research > LinkedIn search
    const resolvedUrl = findPersonLinkedIn(p.name, companyPeopleMap) ?? p.linkedInUrl
    const { rawText, resolvedLinkedInUrl } = await fetchPersonActivity(
      p.name, p.role, industry, lead.city,
      brandVariants,
      resolvedUrl,
      progressFn,
    )
    peopleWithActivity.push({
      name: p.name,
      role: p.role,
      linkedInUrl: resolvedLinkedInUrl ?? resolvedUrl,
      raw: rawText,
    })
  }

  // Company-level activity: Google news + Twitter content script + Instagram content script
  onProgress?.(`Checking company social profiles…`)
  const companyActivity = await fetchCompanyActivity(
    lead.companyName, brandVariants, lead.city, socialUrls, progressFn
  )

  // AI analysis
  const prompt = buildDeepResearchPrompt(
    lead.companyName,
    result.industry ?? lead.keyword ?? '',
    lead.city,
    people.slice(0, 5),
    peopleWithActivity,
    companyActivity
  )

  const ai = await callOpenAI(prompt, apiKey, model)

  // Map AI response to our type
  const peopleActivity: PersonActivity[] = (ai.peopleInsights ?? []).map((p: any) => ({
    name:            p.name ?? '',
    role:            p.role ?? '',
    linkedInUrl:     people.find(x => x.name === p.name)?.linkedInUrl,
    posts:           (p.recentPosts ?? []).map((post: any): SocialPost => ({
      platform: post.platform ?? detectPlatform(post.url ?? ''),
      date:     post.date ?? undefined,
      headline: post.headline ?? undefined,
      snippet:  post.snippet ?? '',
      url:      post.url ?? undefined,
    })).filter((post: SocialPost) => post.snippet),
    topics:          p.topics ?? [],
    activitySummary: p.activitySummary ?? '',
    bestApproach:    p.bestApproach ?? undefined,
  }))

  return {
    researchResultId: result.id!,
    leadId:           lead.id!,
    peopleActivity,
    companySignals:   ai.companySignals ?? [],
    intentSignals:    ai.intentSignals ?? [],
    recommendedPitch: ai.recommendedPitch ?? '',
    pitchTemplate:    ai.pitchTemplate ?? undefined,
    researchedAt:     nowISO(),
  }
}
