// Fetches real company financial data using Gemini's Google Search Grounding.
//
// Gemini searches Google internally — no browser tabs, no bot detection.
// Returns turnover, employee count, CIN, directors, etc. grounded in real web data.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface GroundedCompanyData {
  industry?:            string
  companyType?:         string
  annualTurnover?:      string
  annualTurnoverVerified?: boolean   // true = confirmed from a real web source; false = estimated
  employeeCount?:       string
  employeeCountVerified?: boolean    // true = confirmed from a real web source; false = estimated
  cin?:                 string
  uan?:                 string
  directors?:           string
  address?:             string
  capital?:             string
  summary?:             string
}

function groundingTool(model: string): Record<string, unknown> {
  // gemini-2.x uses google_search; gemini-1.5-x uses google_search_retrieval
  if (/gemini-1\.5/i.test(model)) {
    return { google_search_retrieval: { dynamic_retrieval_config: { mode: 'MODE_DYNAMIC', dynamic_threshold: 0.3 } } }
  }
  return { google_search: {} }
}

function clean(v: unknown): string | undefined {
  if (!v || typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a' || s === 'unknown') return undefined
  return s
}

function parseResponse(text: string): GroundedCompanyData | null {
  const match = text.match(/\{[\s\S]*?\}/)
  if (!match) return null
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const result: GroundedCompanyData = {
      industry:                clean(raw.industry),
      companyType:             clean(raw.companyType),
      annualTurnover:          clean(raw.annualTurnover),
      annualTurnoverVerified:  raw.annualTurnoverVerified === true,
      employeeCount:           clean(raw.employeeCount),
      employeeCountVerified:   raw.employeeCountVerified === true,
      cin:                     clean(raw.cin),
      uan:                     clean(raw.uan),
      directors:               clean(raw.directors),
      address:                 clean(raw.address),
      capital:                 clean(raw.capital),
      summary:                 clean(raw.summary),
    }
    const hasData = Object.values(result).some(Boolean)
    return hasData ? result : null
  } catch { return null }
}

// Per-country registry sources and prompt config for Gemini grounding
const COUNTRY_CONFIG: Record<string, { locationLabel: string; registries: string; currencyNote: string; regIdLabel: string }> = {
  IN: {
    locationLabel: 'India',
    registries: 'MCA, IndiaMART, Tofler, Zauba, JustDial, TradeIndia, and any Indian company directory',
    currencyNote: 'INR (₹) e.g. "₹40 Lakh", "₹1-10 Cr"',
    regIdLabel: 'CIN (21-char MCA Corporate Identification Number)',
  },
  AE: {
    locationLabel: 'UAE',
    registries: 'DED Dubai, Abu Dhabi Chamber, Dubai Chamber of Commerce, Yellow Pages UAE, Kompass Middle East, and any UAE business directory',
    currencyNote: 'AED e.g. "AED 500K", "AED 2M"',
    regIdLabel: 'Trade License Number or DED License Number',
  },
  SA: {
    locationLabel: 'Saudi Arabia',
    registries: 'Saudi Chamber of Commerce, CR (Commercial Registration) lookup, Yellow Pages KSA, Kompass, and any Saudi business directory',
    currencyNote: 'SAR e.g. "SAR 1M", "SAR 5M"',
    regIdLabel: 'CR Number (Commercial Registration Number)',
  },
  QA: {
    locationLabel: 'Qatar',
    registries: 'Qatar Chamber of Commerce, Ministry of Commerce Qatar, Yellow Pages Qatar, and any Qatar business directory',
    currencyNote: 'QAR e.g. "QAR 500K", "QAR 2M"',
    regIdLabel: 'QR (Qatar Commercial Registration Number)',
  },
  KW: {
    locationLabel: 'Kuwait',
    registries: 'Kuwait Chamber of Commerce, Ministry of Commerce Kuwait, Yellow Pages Kuwait, and any Kuwait business directory',
    currencyNote: 'KWD e.g. "KWD 100K", "KWD 500K"',
    regIdLabel: 'Commercial License Number',
  },
  BH: {
    locationLabel: 'Bahrain',
    registries: 'Bahrain Chamber of Commerce, Sijilat (Bahrain business registry), Yellow Pages Bahrain, and any Bahrain business directory',
    currencyNote: 'BHD e.g. "BHD 100K", "BHD 500K"',
    regIdLabel: 'CR Number (Bahrain Commercial Registration)',
  },
  OM: {
    locationLabel: 'Oman',
    registries: 'Oman Chamber of Commerce, Ministry of Commerce Oman, Yellow Pages Oman, and any Oman business directory',
    currencyNote: 'OMR e.g. "OMR 50K", "OMR 200K"',
    regIdLabel: 'CR Number (Oman Commercial Registration)',
  },
}

// Lookup table: ISO2 → full country name for the generic fallback prompt
const ISO_NAMES: Record<string, string> = {
  US:'United States',GB:'United Kingdom',DE:'Germany',FR:'France',IT:'Italy',ES:'Spain',
  NL:'Netherlands',BE:'Belgium',CH:'Switzerland',AT:'Austria',SE:'Sweden',NO:'Norway',
  DK:'Denmark',FI:'Finland',PL:'Poland',CZ:'Czech Republic',RO:'Romania',HU:'Hungary',
  PT:'Portugal',GR:'Greece',TR:'Turkey',RU:'Russia',UA:'Ukraine',
  CN:'China',JP:'Japan',KR:'South Korea',TW:'Taiwan',SG:'Singapore',
  MY:'Malaysia',TH:'Thailand',ID:'Indonesia',PH:'Philippines',VN:'Vietnam',
  AU:'Australia',NZ:'New Zealand',CA:'Canada',MX:'Mexico',BR:'Brazil',
  AR:'Argentina',CO:'Colombia',CL:'Chile',ZA:'South Africa',NG:'Nigeria',
  EG:'Egypt',MA:'Morocco',KE:'Kenya',GH:'Ghana',PK:'Pakistan',
  BD:'Bangladesh',LK:'Sri Lanka',NP:'Nepal',
}

function buildEnrichmentPrompt(companyName: string, city: string, country: string): string {
  const cfg = COUNTRY_CONFIG[country]

  if (cfg) {
    return `Find business information for "${companyName}" in ${city}, ${cfg.locationLabel}. Search ${cfg.registries}.

IMPORTANT: For annualTurnover and employeeCount, you MUST distinguish between:
- VERIFIED: you actually found this value in a search result (registry, directory, LinkedIn etc.) → set the corresponding *Verified field to true
- ESTIMATED: you are inferring/guessing from company name, category, or size signals → set *Verified to false

Return ONLY a JSON object (no markdown, no code block):
{"industry":"infer from business name+type","companyType":"company legal type (LLC, Sole Proprietorship, WLL, etc.) or null","annualTurnover":"value in ${cfg.currencyNote}, else estimated range","annualTurnoverVerified":true,"employeeCount":"real number if found, else estimated range like 10-50","employeeCountVerified":false,"cin":"${cfg.regIdLabel} or null","uan":"secondary registration ID or null","directors":"comma-separated owner/director names or null","address":"registered address or null","capital":"authorized/paid-up capital or null","summary":"one sentence describing what this company does"}`
  }

  // Generic fallback for any country not in the predefined list
  const countryName = ISO_NAMES[country] ?? country
  return `Find business information for "${companyName}" in ${city}, ${countryName}. Search the official company registry, chamber of commerce, LinkedIn, Yellow Pages, Kompass, and any local business directory for ${countryName}.

IMPORTANT: For annualTurnover and employeeCount, you MUST distinguish between:
- VERIFIED: you actually found this value in a search result → set the corresponding *Verified field to true
- ESTIMATED: you are inferring/guessing → set *Verified to false

Return ONLY a JSON object (no markdown, no code block):
{"industry":"infer from business name+type","companyType":"company legal type or null","annualTurnover":"value in local currency if found, else estimated range","annualTurnoverVerified":true,"employeeCount":"real number if found, else estimated range like 10-50","employeeCountVerified":false,"cin":"company registration / license number or null","uan":"secondary registration ID or null","directors":"comma-separated owner/director names or null","address":"registered address or null","capital":"authorized/paid-up capital or null","summary":"one sentence describing what this company does"}`
}

export async function searchCompanyWithGeminiGrounding(
  companyName: string,
  city: string,
  apiKey: string,
  model: string,
  country = 'IN',
): Promise<GroundedCompanyData | null> {
  if (!apiKey.trim()) return null

  const prompt = buildEnrichmentPrompt(companyName, city, country)

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [groundingTool(model)],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.warn(`[geminiGrounding] ${companyName}: HTTP ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!text) return null

    return parseResponse(text)
  } catch (err) {
    console.warn(`[geminiGrounding] "${companyName}": ${err}`)
    return null
  }
}
