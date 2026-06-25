import type { ResearchResult } from '@/types/research'

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION    = '2023-06-01'

interface ExtractedData {
  decisionMaker?: string
  email?: string
  alternatePhone?: string
  website?: string
  linkedIn?: string
  facebook?: string
  instagram?: string
  twitter?: string
  youtube?: string
  whatsapp?: string
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
  teamMembers?: { name: string; role: string }[]
  confidence: number
}

function buildPrompt(context: string): string {
  return `You are a business intelligence assistant specializing in Indian SMBs. Extract structured information from all sources provided.

RULES:
1. Social/contact URLs listed as "Pre-extracted" or "Social media profiles found" — copy EXACTLY into the correct field. Do NOT modify.
2. IndiaMART / Zaubacorp / directory data — extract: "Company CEO", "Total Number of Employees", "Annual Turnover", "Legal Status of Firm", "Nature of Business", directors list, CIN, established year.
3. For teamMembers — extract EVERY named person with their role from ANY source: website About/Team page, IndiaMART CEO field, Zaubacorp directors list, LinkedIn people, Google snippets with titles like "Managing Director", "Director", "Founder", "Owner", "HR", "Sales".
4. For email — prefer business domain emails (e.g. hr@company.com). If ONLY webmail (gmail/yahoo) is found in "Website content" or "Emails found on website", include it — many Indian SMBs use Gmail as their primary business email. NEVER invent an email.
5. decisionMaker — Owner, Proprietor, Managing Director, CEO, Founder, Director, Partner. Use IndiaMART "Company CEO" or Zaubacorp directors list first.
6. For annualTurnover — look in Zaubacorp, IndiaMART, AmbitionBox pages for "Annual Turnover", "Revenue", "Turnover" fields. Also look in Google snippets.
7. Do NOT invent data. Use null if not found.

${context}

Return ONLY valid JSON (no markdown, no explanation):
{
  "decisionMaker": "Full name of owner/CEO/MD/Director from IndiaMART CEO field or any source, else null",
  "email": "Business domain email ONLY (not gmail/yahoo) from website contact page or IndiaMART, else null",
  "alternatePhone": "Secondary phone number if different from main Google Maps number, else null",
  "website": "Official website URL, else null",
  "linkedIn": "LinkedIn company URL — copy EXACTLY from pre-extracted or Google-found URLs, else null",
  "facebook": "Facebook page URL — copy EXACTLY from pre-extracted or Google-found URLs, else null",
  "instagram": "Instagram URL — copy EXACTLY from pre-extracted or Google-found URLs, else null",
  "twitter": "Twitter/X URL — copy EXACTLY from pre-extracted or Google-found URLs, else null",
  "youtube": "YouTube channel URL — copy EXACTLY from pre-extracted or Google-found URLs, else null",
  "whatsapp": "WhatsApp wa.me link or phone — copy EXACTLY from pre-extracted or website, else null",
  "summary": "2-3 sentences: what they do, their specialty, who they serve, certifications if any",
  "tagline": "Company slogan or tagline if found, else null",
  "services": ["all", "services", "and", "products", "found", "across", "all", "sources"],
  "employeeCount": "From IndiaMART 'Total Number of Employees' — map to: 1-10, 10-50, 50-200, 200-500, 500+. Else null",
  "annualTurnover": "From IndiaMART 'Annual Turnover' field — copy exact value e.g. '25-100 Cr', '100-500 Cr'. Else null",
  "yearFounded": 2001,
  "companyType": "From IndiaMART 'Legal Status of Firm' or website — one of: Pvt Ltd, LLP, Proprietorship, Partnership, Public Ltd, NGO. Else null",
  "industry": "Primary industry (e.g. Printing & Packaging, IT Services, Textile, Pharmaceuticals)",
  "headquarters": "City, State from website or IndiaMART address",
  "certifications": ["ISO 9001", "WHO-GMP", "BRC", "DMF", "any quality certifications/accreditations from website Achievements/Certifications page or IndiaMART"],
  "majorClients": ["Cipla", "Dr. Reddy's", "IPCA", "list every named client/customer/brand mentioned on website Clients page, About page, or any source — company names only"],
  "teamMembers": [
    {"name": "Full Name from IndiaMART CEO / website team / LinkedIn people", "role": "their exact title"}
  ],
  "confidence": 0.85
}

Confidence guide: 0.9+ = multiple sources confirm data, 0.7-0.9 = one strong source, 0.5-0.7 = partial data, below 0.5 = mostly guessed.`
}

export async function callClaudeResearch(
  context: string,
  apiKey: string,
  model: string
): Promise<ExtractedData | null> {
  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: buildPrompt(context) }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Claude API ${response.status}: ${err}`)
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text ?? ''

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    return JSON.parse(jsonMatch[0]) as ExtractedData
  } catch (err) {
    console.error('[claudeResearch] Error:', err)
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

export function buildResearchResult(
  leadId: number,
  jobId: number,
  data: ExtractedData,
  sourceUrl?: string
): Omit<ResearchResult, 'id' | 'createdAt'> {
  return {
    leadId,
    jobId,
    decisionMaker:  clean(data.decisionMaker),
    email:          clean(data.email),
    alternatePhone: clean(data.alternatePhone),
    website:        cleanUrl(data.website),
    linkedIn:       cleanUrl(data.linkedIn),
    facebook:       cleanUrl(data.facebook),
    instagram:      cleanUrl(data.instagram),
    twitter:        cleanUrl(data.twitter),
    youtube:        cleanUrl(data.youtube),
    whatsapp:       cleanUrl(data.whatsapp),
    summary:        clean(data.summary),
    tagline:        clean(data.tagline),
    services:       data.services?.filter((s) => s && s !== 'null') ?? undefined,
    employeeCount:  clean(data.employeeCount),
    annualTurnover: clean(data.annualTurnover),
    yearFounded:    data.yearFounded ?? undefined,
    companyType:    clean(data.companyType),
    industry:       clean(data.industry),
    headquarters:   clean(data.headquarters),
    certifications: data.certifications?.filter((c) => c && c !== 'null') ?? undefined,
    majorClients:   data.majorClients?.filter((c) => c && c !== 'null') ?? undefined,
    teamMembers:    data.teamMembers?.filter((m) => m.name && m.name !== 'null') ?? undefined,
    confidence:     data.confidence ?? 0.5,
    sourceUrl,
  }
}
