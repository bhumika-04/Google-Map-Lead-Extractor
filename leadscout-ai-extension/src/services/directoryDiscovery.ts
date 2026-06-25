// Background lead discovery from business directories (no tab needed).
// Fetches IndiaMART and JustDial search pages directly from the service worker
// and extracts company listings as structured leads.

const FETCH_TIMEOUT_MS = 12000

async function safeFetch(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
      },
    })
    clearTimeout(t)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return null
    return await res.text()
  } catch {
    return null
  }
}

export interface DiscoveredLead {
  companyName: string
  phone?: string
  address?: string
  website?: string
  category?: string
  city: string
  source: 'indiamart' | 'justdial' | 'tradeindia' | 'google_search'
  sourceUrl?: string
}

// ─── IndiaMART discovery ──────────────────────────────────────────────────────

export async function discoverFromIndiamart(keyword: string, city: string): Promise<DiscoveredLead[]> {
  const q = encodeURIComponent(`${keyword} ${city}`)
  const url = `https://dir.indiamart.com/search.mp?ss=${q}`
  const html = await safeFetch(url)
  if (!html) return []

  const leads: DiscoveredLead[] = []

  // Extract company cards — IndiaMART uses <div class="companyname"> or similar
  // Strategy: find all company names by looking for patterns in the HTML
  const nameRe = /<a[^>]+class="[^"]*(?:company-name|companyName|imabs)[^"]*"[^>]*>([^<]+)<\/a>/gi
  const phoneRe = /(?:tel:|>)\s*(\+?91[\s\-]?\d{5}[\s\-]?\d{5}|\d{10})/g
  const cityRe  = new RegExp(city, 'i')

  // Simpler approach: look for company profile links and extract names from them
  const profileLinkRe = /href="(https?:\/\/[\w\-]+\.indiamart\.com\/[^"]+)"[^>]*>\s*<[^>]+>([^<]{5,80})<\/[^>]+>/gi
  let m: RegExpExecArray | null

  const seen = new Set<string>()

  while ((m = profileLinkRe.exec(html)) !== null) {
    const sourceUrl = m[1]
    const rawName = m[2].trim().replace(/\s+/g, ' ')

    // Filter: must look like a company name (not a product/category)
    if (
      rawName.length < 4 ||
      rawName.length > 80 ||
      seen.has(rawName.toLowerCase()) ||
      /^\d+$/.test(rawName) ||
      /^(view|read|more|click|contact|send|get|buy|sell|enquiry)$/i.test(rawName)
    ) continue

    seen.add(rawName.toLowerCase())
    leads.push({
      companyName: rawName,
      city,
      category: keyword,
      source: 'indiamart',
      sourceUrl: sourceUrl.split('?')[0],
    })

    if (leads.length >= 30) break
  }

  // If profile link approach found nothing, fall back to text pattern
  if (leads.length === 0) {
    const textNameRe = /class="[^"]*(?:company|firm|supplier)[^"]*"[^>]*>([A-Z][A-Za-z0-9\s&.,()Pvt LtdLLP]{4,70})<\//g
    while ((m = textNameRe.exec(html)) !== null) {
      const name = m[1].trim()
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase())
        leads.push({ companyName: name, city, category: keyword, source: 'indiamart' })
        if (leads.length >= 30) break
      }
    }
  }

  return leads
}

// ─── JustDial discovery ───────────────────────────────────────────────────────

export async function discoverFromJustDial(keyword: string, city: string): Promise<DiscoveredLead[]> {
  const q = encodeURIComponent(keyword.replace(/\s+/g, '-'))
  const c = encodeURIComponent(city)
  const url = `https://www.justdial.com/${c}/${q}`
  const html = await safeFetch(url)
  if (!html) return []

  const leads: DiscoveredLead[] = []
  const seen = new Set<string>()

  // JustDial listing: company names often in <span class="lng_cont_name"> or similar
  // Try multiple patterns
  const patterns = [
    /<span[^>]+class="[^"]*(?:lng_cont_name|store-name|businessname)[^"]*"[^>]*>([^<]{4,80})<\/span>/gi,
    /<p[^>]+class="[^"]*(?:business-name|bname|store-name)[^"]*"[^>]*>([^<]{4,80})<\/p>/gi,
    /itemprop="name"[^>]*>([^<]{4,80})</gi,
  ]

  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const name = m[1].trim().replace(/\s+/g, ' ')
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase())
        leads.push({ companyName: name, city, category: keyword, source: 'justdial' })
        if (leads.length >= 30) break
      }
    }
    if (leads.length > 0) break
  }

  return leads
}

// ─── Google Search discovery ──────────────────────────────────────────────────
// Searches for companies on Google and extracts business names + websites from results.
// Also extracts IndiaMART/JustDial profile URLs for further enrichment.

export async function discoverFromGoogleSearch(keyword: string, city: string): Promise<DiscoveredLead[]> {
  // Search specifically for directory listings which have structured company data
  const queries = [
    `${keyword} companies in ${city} site:indiamart.com`,
    `${keyword} ${city} site:justdial.com`,
    `${keyword} ${city} site:tradeindia.com`,
  ]

  const leads: DiscoveredLead[] = []
  const seen = new Set<string>()

  for (const query of queries) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en&gl=in`
    const html = await safeFetch(url)
    if (!html) continue

    // Google result title pattern: <h3>Company Name - ...</h3>
    const titleRe = /<h3[^>]*>([^<]{5,80})<\/h3>/gi
    let m: RegExpExecArray | null

    while ((m = titleRe.exec(html)) !== null) {
      const raw = m[1].trim()
        .replace(/\s*[-–|].*$/, '')   // strip "- City, State" suffix
        .replace(/\s+/g, ' ')
        .trim()

      if (
        raw.length >= 4 &&
        raw.length <= 80 &&
        !seen.has(raw.toLowerCase()) &&
        !/^(google|search|home|about|contact|login|signup)$/i.test(raw)
      ) {
        seen.add(raw.toLowerCase())
        leads.push({
          companyName: raw,
          city,
          category: keyword,
          source: 'google_search',
        })
        if (leads.length >= 40) break
      }
    }
  }

  return leads
}

// ─── Combined discovery ───────────────────────────────────────────────────────

export async function discoverLeads(keyword: string, city: string): Promise<{
  leads: DiscoveredLead[]
  sources: string[]
}> {
  const [indiaMartLeads, justDialLeads, googleLeads] = await Promise.all([
    discoverFromIndiamart(keyword, city).catch(() => [] as DiscoveredLead[]),
    discoverFromJustDial(keyword, city).catch(() => [] as DiscoveredLead[]),
    discoverFromGoogleSearch(keyword, city).catch(() => [] as DiscoveredLead[]),
  ])

  // Merge, deduplicate by company name
  const all: DiscoveredLead[] = []
  const seen = new Set<string>()

  for (const lead of [...indiaMartLeads, ...justDialLeads, ...googleLeads]) {
    const key = lead.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!seen.has(key)) {
      seen.add(key)
      all.push(lead)
    }
  }

  const sources: string[] = []
  if (indiaMartLeads.length) sources.push(`IndiaMART (${indiaMartLeads.length})`)
  if (justDialLeads.length)  sources.push(`JustDial (${justDialLeads.length})`)
  if (googleLeads.length)    sources.push(`Google (${googleLeads.length})`)

  return { leads: all, sources }
}
