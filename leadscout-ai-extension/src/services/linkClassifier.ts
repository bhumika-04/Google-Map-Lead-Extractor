import type { DetectedType } from '@/types/searchEvidence'
import { COUNTRY_INTELLIGENCE } from '@/config/countryIntelligence'

// Domain → DetectedType pattern table, checked in order.
const DOMAIN_RULES: [RegExp, DetectedType][] = [
  [/linkedin\.com/i,    'linkedin'],
  [/facebook\.com/i,    'facebook'],
  [/instagram\.com/i,   'instagram'],
  [/youtube\.com/i,     'youtube'],
  [/indiamart\.com/i,   'indiamart'],
  [/tradeindia\.com/i,  'tradeindia'],
  [/zaubacorp\.com/i,   'zaubacorp'],
]

// Official corporate registries — union of every country's registry sources
// from the country intelligence layer, plus globals. Highest-trust source type.
const REGISTRY_DOMAINS = [
  ...new Set([
    ...Object.values(COUNTRY_INTELLIGENCE).flatMap((c) => c.businessRegistrySources),
    'opencorporates.com', 'dnb.com', 'dun-bradstreet.com',
    'mca.gov.in', 'tofler.in', 'zauba.com',
    'companieshouse.gov.uk', 'endole.co.uk',
    'sijilat.bh', 'business.gov.om', 'acra.gov.sg',
  ]),
]

// News / press outlets — useful for expansion & product signals.
const NEWS_DOMAINS = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'forbes.com', 'businesswire.com', 'prnewswire.com',
  // Gulf / MENA press
  'gulfnews.com', 'khaleejtimes.com', 'thenationalnews.com', 'arabnews.com',
  'timesofoman.com', 'omanobserver.om', 'muscatdaily.com', 'oman-tribune.com',
  'zawya.com', 'tradearabia.com', 'gulfbusiness.com', 'arabianbusiness.com',
  // India press
  'timesofindia.com', 'economictimes.indiatimes.com', 'business-standard.com',
  'livemint.com', 'thehindubusinessline.com', 'printweek.in', 'printweekindia.com',
  // Africa
  'businessdailyafrica.com', 'monitor.co.ug', 'nation.africa',
]

const DIRECTORY_DOMAINS = [
  // India
  'justdial.com', 'sulekha.com', 'exportersindia.com', 'zauba.com', 'indiainfoline.com',
  'tofler.in', 'mca.gov.in', 'registrationindia.com',
  // India — listing marketplaces that otherwise masquerade as official websites
  'magicpin.in', 'grotal.com', 'asklaila.com', 'yellowpages.in', 'indiabizlist.com',
  // Gulf / MENA — general directories
  'yellowpages.ae', 'yellowpages.com.sa', 'yellowpages.com.kw',
  'dubizzle.com', 'zawya.com', 'companiesintheuae.com', 'uaecompanycheck.com',
  'tradearabia.com', 'gulfbusiness.com', 'qataryellowpages.com', 'omanpages.com',
  'bahrainyellowpages.com', 'saudibusiness.com', 'bizcommunity.com',
  // Gulf / MENA — business listing aggregators that appear in search results
  'pinkbazaar.in', 'magana.ma', 'bertina.ir', 'search.bertina.ir',
  'omanet.om', 'omantelecommunications.com', 'oman-directory.com',
  'gulfyp.com', 'arabiyp.com', 'businesslist.com.om',
  // UK / Europe
  'companieshouse.gov.uk', 'endole.co.uk', 'duedil.com',
  'europages.com', 'kompass.com', 'europages.co.uk',
  // Global registries & directories
  'opencorporates.com', 'dnb.com', 'dun-bradstreet.com',
  'crunchbase.com', 'tracxn.com', 'manta.com', 'globalspec.com',
  'cylex.de', 'cylex-uk.co.uk', 'hotfrog.com', 'hotfrog.com.au',
  'brownbook.net', 'whereis.com', 'ypoman.com',
  // Contact / company data aggregators
  'zoominfo.com', 'rocketreach.co', 'ampliz.com', 'apollo.io',
  'lusha.com', 'signalhire.com', 'hunter.io', 'snov.io',
  // Arabic / Gulf yellow pages & B2B directories
  'yellowpages-ar.cybo.com', 'cybo.com', 'gulflead.com', 'gulf-leads.com',
  'gulfleads.ae', 'gulfleads.com',   // GulfLeads — has Industry, Size, Founded, Address
  // B2B trade portals
  'trademo.com', 'panjiva.com', 'importyeti.com', 'packaging-labelling.com',
  // APAC
  'yellowpages.com.au', 'businesslist.com.au', 'nzbn.govt.nz',
  'sgpbusiness.com', 'businessdirectory.com.sg',
  // Africa
  'africabusiness.com', 'yellowpages.co.za',
]

const REVIEW_DOMAINS = [
  'glassdoor.com', 'glassdoor.co.in', 'glassdoor.co.uk',
  'mouthshut.com', 'trustpilot.com', 'google.com/maps', 'ambitionbox.com',
  'clutch.co', 'g2.com', 'capterra.com',
]

// Domains that are NEVER useful for company intelligence — navigation apps,
// search engines, social aggregators, encyclopedias, etc.
const NON_COMPANY_DOMAINS = [
  // Navigation / maps apps — open a driving-directions page, not company info
  'waze.com', 'maps.apple.com', 'mapquest.com', 'here.com', 'tomtom.com',
  'openstreetmap.org', 'foursquare.com', 'tripadvisor.com',
  // Search engines & encyclopedias
  'wikipedia.org', 'bing.com', 'yahoo.com', 'baidu.com', 'yandex.ru',
  // Social / Q&A / content platforms
  'quora.com', 'reddit.com', 'twitter.com', 'x.com', 'pinterest.com',
  'medium.com', 'wordpress.com', 'blogspot.com',
  // Job boards (employee reviews, not company intelligence)
  'indeed.com', 'naukri.com', 'bayt.com', 'monster.com',
]

// Sub-page segments on aggregator/directory sites that 404 —
// stripping them gives the canonical profile page URL.
const AGGREGATOR_SUBPAGE_STRIP: { domain: string; pattern: RegExp }[] = [
  // ZoomInfo company: /pic/<name>/<id>/clients|infrastructure|org-chart|...
  { domain: 'zoominfo.com',    pattern: /^(\/pic\/[^/]+\/[^/]+)\/.+$/ },
  // ZoomInfo person: /p/<name>/<id>/... — already excluded but strip to be safe
  { domain: 'zoominfo.com',    pattern: /^(\/p\/[^/]+\/[^/]+)\/.+$/ },
  // RocketReach: /company-name-profile_xxx/services|clients|...
  { domain: 'rocketreach.co',  pattern: /^(\/[^/]+-profile_[a-z0-9]+)\/.+$/ },
  // LinkedIn company: /company/<name>/posts|about|people|...
  { domain: 'linkedin.com',    pattern: /^(\/company\/[^/]+)\/.+$/ },
  // Ampliz / Apollo sub-pages
  { domain: 'ampliz.com',      pattern: /^(\/company\/[^/]+)\/.+$/ },
  { domain: 'apollo.io',       pattern: /^(\/companies\/[^/]+)\/.+$/ },
]

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    for (const rule of AGGREGATOR_SUBPAGE_STRIP) {
      if (host.includes(rule.domain)) {
        const m = parsed.pathname.match(rule.pattern)
        if (m) {
          parsed.pathname = m[1]
          parsed.search = ''
          parsed.hash = ''
          return parsed.toString()
        }
      }
    }
  } catch {}
  return url
}

export function classifyUrl(url: string): DetectedType {
  let hostname: string
  let pathname: string
  try {
    const parsed = new URL(url)
    hostname = parsed.hostname.replace(/^www\./, '').toLowerCase()
    pathname = parsed.pathname.toLowerCase()
  } catch {
    return 'unknown'
  }

  // Path-level exclusions — same domain, wrong page type:
  if (hostname.includes('instagram.com')) {
    // Location/explore pages are area discovery, not company profiles
    if (pathname.startsWith('/explore/')) return 'unknown'
    // Individual posts/reels — no company intelligence, just a single piece of content
    if (pathname.startsWith('/p/') || pathname.startsWith('/reel/') || pathname.startsWith('/tv/')) return 'unknown'
  }
  if (hostname.includes('facebook.com')) {
    // Individual posts, events, places — not company profiles
    if (/^\/[^/]+\/posts\//.test(pathname)) return 'unknown'
    if (pathname.startsWith('/places/') || pathname.startsWith('/events/')) return 'unknown'
    if (pathname.startsWith('/photo') || pathname.startsWith('/video')) return 'unknown'
  }
  // ZoomInfo person pages (/p/) are employee profiles, not company intelligence
  if (hostname.includes('zoominfo.com') && pathname.startsWith('/p/')) return 'unknown'

  // IndiaMART city/category listing pages (dir.indiamart.com/<city>/<cat>.html)
  // list DOZENS of different suppliers — not the target company's profile page
  // (that lives at indiamart.com/<company-slug>/). Classify as a generic
  // directory so they can't outrank real profile pages, and extraction from
  // them carries directory-level trust instead of marketplace-profile trust.
  if (hostname === 'dir.indiamart.com') return 'company_directory'

  for (const [pattern, type] of DOMAIN_RULES) {
    if (pattern.test(hostname)) return type
  }

  // Trust order: registry > news > directory > review
  if (REGISTRY_DOMAINS.some((d) => hostname.includes(d))) return 'corporate_registry'
  if (NEWS_DOMAINS.some((d) => hostname.includes(d))) return 'news'
  if (DIRECTORY_DOMAINS.some((d) => hostname.includes(d))) return 'company_directory'
  if (REVIEW_DOMAINS.some((d) => hostname.includes(d))) return 'review_site'
  if (NON_COMPANY_DOMAINS.some((d) => hostname.includes(d))) return 'unknown'

  // Anything else with a standalone domain (not a known platform/aggregator) is
  // treated as a candidate official website.
  return 'official_website'
}

// Legal-entity suffixes that shouldn't count toward name-match scoring —
// "Shiv Offset India Pvt Ltd" and "Shiv Offset India" should score identically.
const LEGAL_SUFFIXES = [
  // Universal entity types
  'pvt', 'ltd', 'limited', 'private', 'llp', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'enterprises', 'enterprise', 'industries', 'group',
  // Gulf entity types
  'llc', 'fze', 'fzc', 'fzco', 'wll', 'bsc', 'pjsc', 'establishment', 'est', 'trading',
  // UK / Europe
  'plc', 'sarl', 'gmbh', 'bv', 'nv', 'sas', 'srl',
  // Country names (shouldn't count toward name uniqueness)
  'india', 'uae', 'saudi', 'qatar', 'kuwait', 'bahrain', 'oman',
  'pakistan', 'bangladesh', 'singapore', 'malaysia',
  'international', 'global', 'worldwide',
]

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !LEGAL_SUFFIXES.includes(t))
  )
}

// Returns true when the company name contains characters outside printable ASCII
// (i.e. Urdu, Arabic, Devanagari, CJK, etc.).
function isNonLatinName(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code > 127) return true
  }
  return false
}

// Normalized token-overlap (Jaccard-style) between the company name and the
// evidence's title+snippet. Returns 0-1. Used to reject evidence that clearly
// belongs to a different, same-search-result company.
export function matchesCompany(evidenceTitle: string, evidenceSnippet: string, companyName: string): number {
  // Non-Latin company names (Urdu, Arabic, Devanagari, CJK, etc.) cannot be
  // reliably matched against evidence text using Latin tokenization — accept all
  // results and let per-source AI confidence scoring filter mismatches instead.
  if (isNonLatinName(companyName)) return 1.0

  const nameTokens = tokenize(companyName)
  // Empty after stripping (e.g. pure punctuation name) — accept all rather than reject all.
  if (nameTokens.size === 0) return 1.0

  const evidenceTokens = tokenize(`${evidenceTitle} ${evidenceSnippet}`)
  if (evidenceTokens.size === 0) return 0

  let overlap = 0
  for (const t of nameTokens) if (evidenceTokens.has(t)) overlap++

  // Score relative to how much of the company name itself was found —
  // a snippet is long and noisy, so we don't penalize for extra unrelated tokens.
  return overlap / nameTokens.size
}

// Strict title-only match — used for LinkedIn /company/ page candidates from
// the site: discovery search. Unlike matchesCompany (title+snippet), this
// deliberately ignores the snippet: a search result's snippet can mention the
// target company in a completely unrelated context (e.g. a sister brand's
// LinkedIn page whose snippet says "Nova Dairy (Sterling Agro Industries Ltd)
// markets..." — that's Nova Dairy's OWN page, not Sterling Agro's, but the
// snippet text alone would score a perfect match). The page title is what
// actually identifies whose LinkedIn page this is.
export function matchesCompanyTitle(evidenceTitle: string, companyName: string): number {
  if (isNonLatinName(companyName)) return 1.0

  const nameTokens = tokenize(companyName)
  if (nameTokens.size === 0) return 1.0

  const titleTokens = tokenize(evidenceTitle)
  if (titleTokens.size === 0) return 0

  let overlap = 0
  for (const t of nameTokens) if (titleTokens.has(t)) overlap++
  return overlap / nameTokens.size
}

export const MATCH_THRESHOLD = 0.35
