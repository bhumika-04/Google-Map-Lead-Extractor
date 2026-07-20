import type { ResearchResult } from '@/types/research'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemini-flash-latest'

interface ExtractedData {
  // Contact
  decisionMaker?: string
  decisionMakerLinkedIn?: string
  email?: string
  alternatePhone?: string
  // Online presence
  website?: string
  linkedIn?: string
  facebook?: string
  instagram?: string
  twitter?: string
  youtube?: string
  whatsapp?: string
  // Business overview
  summary?: string
  tagline?: string
  services?: string[]
  employeeCount?: string
  annualTurnover?: string
  yearFounded?: number
  companyType?: string
  industry?: string
  headquarters?: string
  certifications?: string[]
  majorClients?: string[]
  supplierBuyerType?: 'manufacturer' | 'trader' | 'distributor' | 'service_provider' | 'mixed'
  exportMarkets?: string[]
  currentSoftware?: string[]
  expansionSignals?: string[]
  // Buyer persona
  painPoints?: string[]
  // People
  teamMembers?: { name: string; role: string }[]
  confidence: number
}

function buildPrompt(companyName: string, city: string, extraContext: string): string {
  return `You are a B2B business intelligence analyst. Extract everything you can about the Indian company below from the pre-fetched source data provided. For most fields, only use data explicitly present in the sources — do NOT invent contact details, names, URLs, or client lists. EXCEPTION: for painPoints specifically, you MUST always infer 2-4 operational pain points from the company's industry, size, and business type even if not stated in the source — this is AI analysis, not extraction.

COMPANY: "${companyName}"
CITY: ${city}

SOURCE DATA (website, Google search, IndiaMART, JustDial — already fetched):
${extraContext || 'None'}

FIELD RULES:
- decisionMaker: Owner > CEO > MD > Director > Founder. Full name only. If multiple, pick highest authority. Null if not found.
- decisionMakerLinkedIn: Personal LinkedIn URL of the decision maker (linkedin.com/in/...), NOT the company page. Null if not found.
- email: Prefer business domain emails (info@company.com). If ONLY webmail (gmail/yahoo) is found on the company's own website, include it — many Indian SMBs use Gmail as their official contact. NEVER invent an email.
- supplierBuyerType: "manufacturer" = they make/produce products; "trader" = they buy & resell; "distributor" = authorized distributor; "service_provider" = pure service; "mixed" = both.
- annualTurnover: Look for "Annual Turnover", "Revenue", "Turnover" in IndiaMART, Zaubacorp, or any source. Copy the exact string (e.g. "₹25 Lakh - ₹1 Cr", "5 Lakh or Less", "25-100 Cr"). If not explicitly stated but employeeCount is known, estimate: 1-10 employees → "Below 1 Cr (est.)", 10-50 → "1-10 Cr (est.)", 50-200 → "10-50 Cr (est.)". Null only if both source data AND employee count are completely unavailable.
- painPoints: ALWAYS return 2-4 specific pain points inferred from their industry and company type (e.g. printing company: "Managing ink/paper cost volatility", "Meeting tight delivery deadlines during peak season"). You MUST populate this — it is AI analysis, not source extraction.
- currentSoftware: List any software/ERP/tools found in job listings, website, or LinkedIn. Return [] if not found.
- expansionSignals: Any evidence of growth — active job listings count, new branch opening, new product launch, recent news. Return [] if none.
- exportMarkets: Countries they export to. Only include if explicitly mentioned. Return [] otherwise.
- majorClients: Every named company mentioned as their client/customer. Return [] if none found.
- teamMembers: Every named person with their role across all sources. Return [] if none found.
- certifications: All quality/compliance certifications found. Return [] if none.

Return ONLY valid JSON (no markdown, no explanation):
{
  "decisionMaker": "Full Name",
  "decisionMakerLinkedIn": "https://linkedin.com/in/person-slug or null",
  "email": "contact@company.com or null",
  "alternatePhone": "secondary phone or null",
  "website": "https://... or null",
  "linkedIn": "https://linkedin.com/company/... or null",
  "facebook": "https://facebook.com/... or null",
  "instagram": "https://instagram.com/... or null",
  "twitter": "https://twitter.com/... or null",
  "youtube": "https://youtube.com/... or null",
  "whatsapp": "wa.me/91XXXXXXXXXX or null",
  "summary": "2-3 sentences: what they do, who they serve, key strengths",
  "tagline": "company slogan if found, else null",
  "services": ["Product A", "Service B", "...all found"],
  "employeeCount": "1-10 | 10-50 | 50-200 | 200-500 | 500+ or null",
  "annualTurnover": "e.g. '10-25 Cr' | '25-100 Cr' | '100-500 Cr' | '500 Cr+' or null",
  "yearFounded": 2001,
  "companyType": "Pvt Ltd | LLP | Proprietorship | Partnership | Public Ltd or null",
  "industry": "primary industry sector",
  "headquarters": "City, State",
  "certifications": ["ISO 9001:2015", "WHO-GMP", "...every cert found"],
  "majorClients": ["Client Co 1", "Client Co 2", "...every named client"],
  "supplierBuyerType": "manufacturer | trader | distributor | service_provider | mixed",
  "exportMarkets": ["USA", "Germany", "UAE"] or [],
  "currentSoftware": ["Tally", "Excel"] or [],
  "expansionSignals": ["Hiring 5 engineers on Naukri (Dec 2024)", "..."] or [],
  "painPoints": ["Specific pain point 1", "Specific pain point 2", "...2-4 items"],
  "teamMembers": [{"name": "Full Name", "role": "Their Title"}, ...],
  "confidence": 0.85
}

Confidence: 0.9+ = multiple sources confirmed, 0.7-0.9 = one strong source, 0.5-0.7 = partial data only.`
}

export async function callGeminiResearch(
  companyName: string,
  city: string,
  extraContext: string,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<ExtractedData | null> {
  try {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: buildPrompt(companyName, city, extraContext) }],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Gemini API ${response.status}: ${err}`)
    }

    const data = await response.json()
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    return JSON.parse(jsonMatch[0]) as ExtractedData
  } catch (err) {
    console.error('[geminiResearch] Error:', err)
    return null
  }
}

function clean(v: string | null | undefined): string | undefined {
  if (!v || v === 'null' || v === 'undefined' || v.trim() === '') return undefined
  return v.trim()
}

function cleanUrl(v: string | null | undefined): string | undefined {
  const s = clean(v)
  if (!s) return undefined
  if (!s.startsWith('http://') && !s.startsWith('https://') && !s.startsWith('wa.me')) return undefined
  return s
}

function cleanArr(arr: (string | null | undefined)[] | null | undefined): string[] | undefined {
  if (!arr || arr.length === 0) return undefined
  const filtered = arr.filter((s): s is string => !!s && s !== 'null' && s.trim() !== '')
  return filtered.length > 0 ? filtered : undefined
}

export function buildResearchResult(
  leadId: number,
  jobId: number,
  data: ExtractedData,
  sourceUrl?: string
): Omit<ResearchResult, 'id' | 'createdAt'> {
  return {
    leadId,
    jobId,
    decisionMaker:        clean(data.decisionMaker),
    decisionMakerLinkedIn: cleanUrl(data.decisionMakerLinkedIn),
    email:                clean(data.email),
    alternatePhone:       clean(data.alternatePhone),
    website:              cleanUrl(data.website),
    linkedIn:             cleanUrl(data.linkedIn),
    facebook:             cleanUrl(data.facebook),
    instagram:            cleanUrl(data.instagram),
    twitter:              cleanUrl(data.twitter),
    youtube:              cleanUrl(data.youtube),
    whatsapp:             cleanUrl(data.whatsapp),
    summary:              clean(data.summary),
    tagline:              clean(data.tagline),
    services:             cleanArr(data.services),
    employeeCount:        clean(data.employeeCount),
    annualTurnover:       clean(data.annualTurnover),
    yearFounded:          data.yearFounded ?? undefined,
    companyType:          clean(data.companyType),
    industry:             clean(data.industry),
    headquarters:         clean(data.headquarters),
    certifications:       cleanArr(data.certifications),
    majorClients:         cleanArr(data.majorClients),
    supplierBuyerType:    data.supplierBuyerType ?? undefined,
    exportMarkets:        cleanArr(data.exportMarkets),
    currentSoftware:      cleanArr(data.currentSoftware),
    expansionSignals:     cleanArr(data.expansionSignals),
    painPoints:           cleanArr(data.painPoints),
    teamMembers:          data.teamMembers?.filter((m) => m.name && m.name !== 'null') ?? undefined,
    confidence:           data.confidence ?? 0.5,
    sourceUrl,
  }
}
