// Evidence-based company profile extractor.
// Unlike the memory-based batch prompt, this extractor works only from
// fetched page content — each field must be backed by the provided text.
//
// Translation architecture: every field keeps the verbatim originalQuote in
// the source language (Arabic, Urdu, …) alongside its English value. The
// original is never overwritten — value = English translation, originalQuote
// = untouched source snippet. Deterministic normalizers then add currency
// codes / entity types / role categories on top.

import { normalizeCompanyType, normalizeCurrency, normalizeRole } from '@/utils/normalizeIntl'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const CLAUDE_URL  = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL  = 'https://api.openai.com/v1/chat/completions'

export interface EvidenceField {
  /** English value (translated when the source is non-English) */
  value: string | null
  /** Verbatim snippet from the source text, in its original language */
  originalQuote?: string | null
  sourceUrl: string | null
  confidence: number
}

export interface EvidencePersonField {
  name: string | null
  designation: string | null
  originalQuote?: string | null
  sourceUrl: string | null
  confidence: number
}

export interface IcpFit {
  status: 'high_fit' | 'medium_fit' | 'low_fit' | 'reject'
  reason: string
  confidence: number
}

// Nested evidence-backed response from AI
export interface EvidenceResponse {
  industry:        EvidenceField
  companyType:     EvidenceField
  employeeCount:   EvidenceField
  annualTurnover:  EvidenceField
  yearFounded:     EvidenceField
  decisionMakers:  EvidencePersonField[]
  summary:         EvidenceField
  productsServices: EvidenceField
  gstNumber:       EvidenceField
  icpFit:          IcpFit
  overallConfidence: number
  // LinkedIn-specific (populated only when sourceType === 'linkedin')
  linkedinFollowers?:   EvidenceField
  linkedinSpecialties?: EvidenceField
  linkedinAbout?:       EvidenceField
  linkedinPeople?:      { name: string | null; title: string | null; profileUrl: string | null; confidence: number }[]
  linkedinRecentPost?:  { date: string | null; snippet: string | null; confidence: number }
}

// Flat shape compatible with companyResearchAggregator's ExtractedData
export interface FlatExtractedData {
  decisionMaker?: string
  decisionMakerRole?: string        // normalized category (Founder/Owner, MD, …)
  decisionMakerLinkedIn?: string
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
  gstNumber?: string
  employeeCount?: string
  annualTurnover?: string
  annualTurnoverCurrency?: string   // detected currency code (OMR, AED, INR…)
  annualTurnoverApproxUsd?: number  // approximate USD for cross-country comparison
  yearFounded?: number
  companyType?: string
  companyTypeNormalized?: string    // LLC / SAOC / Private Limited …
  industry?: string
  headquarters?: string
  certifications?: string[]
  majorClients?: string[]
  teamMembers?: { name: string; role: string }[]
  painPoints?: string[]
  expansionSignals?: string[]
  currentSoftware?: string[]
  supplierBuyerType?: 'manufacturer' | 'trader' | 'distributor' | 'service_provider' | 'mixed'
  exportMarkets?: string[]
  icpFit?: IcpFit
  confidence: number
  /** Verbatim source-language snippets backing each field — original never overwritten */
  originalQuotes?: Record<string, string>
  /** ISO 639-1 language the source page was written in */
  sourceLanguage?: string
  // LinkedIn-specific (populated only when source page is linkedin)
  linkedinFollowers?:   string
  linkedinSpecialties?: string[]
  linkedinAbout?:       string
  linkedinPeople?:      { name: string; title: string; profileUrl?: string }[]
  linkedinRecentPost?:  { date: string; snippet: string }
}

function buildEvidencePrompt(
  companyName: string,
  city: string,
  sourceUrl: string,
  sourceType: string,
  evidence: string,
  businessProfile: string,
  sourceLanguage?: string,
): string {
  const isLinkedIn = sourceType === 'linkedin'
  const isDirectory = sourceType === 'company_directory' || sourceType === 'indiamart' || sourceType === 'tradeindia'
  const isNonEnglish = !!sourceLanguage && sourceLanguage !== 'en'

  const translationRules = isNonEnglish ? `
- The evidence text is primarily in a non-English language (detected: "${sourceLanguage}").
- "value" MUST always be in ENGLISH — translate before filling it in.
- "originalQuote" MUST be the verbatim snippet from the evidence text, in its ORIGINAL language, that backs the value. Never translate originalQuote.` : `
- ALL "value" fields must be in English. If any part of the evidence is in another language, translate the value to English and put the verbatim source snippet in "originalQuote".`

  const linkedInInstructions = isLinkedIn ? `

LINKEDIN-SPECIFIC FIELDS TO EXTRACT:
- linkedinFollowers: Follower count shown near the top (e.g. "1,234 followers" → extract "1,234")
- linkedinSpecialties: The Specialties section text (comma-separated as one string)
- linkedinAbout: The full company About / description text block
- linkedinPeople: Each person listed under People / Key employees — name, job title, and LinkedIn profile URL (starts with /in/ or linkedin.com/in/)
- linkedinRecentPost: The most recent visible post — its displayed date (as-is) and content snippet (first 200 chars)` : ''

  const linkedInSchema = isLinkedIn ? `,
  "linkedinFollowers": { "value": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "linkedinSpecialties": { "value": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "linkedinAbout": { "value": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "linkedinPeople": [{ "name": null, "title": null, "profileUrl": null, "confidence": 0 }],
  "linkedinRecentPost": { "date": null, "snippet": null, "confidence": 0 }` : ''

  return `You are an evidence-based B2B company intelligence extractor.

TARGET COMPANY: "${companyName}" | ${city}
SOURCE TYPE: ${sourceType}
SOURCE URL: ${sourceUrl}

RULES:
- Extract ONLY from the evidence text provided below — do NOT use training memory.
- Do NOT mix data from similarly-named companies.
- If the evidence does not clearly refer to "${companyName}" in ${city}, set overallConfidence below 0.4 and leave most fields null.
- Every non-null field must reference sourceUrl = "${sourceUrl}".
- Return null for any field not found in the evidence.${translationRules}
- gstNumber: the 15-character Indian GSTIN (format: 2 digit state code + 10 char PAN + entity code + "Z" + checksum, e.g. "24AAACC1206D1Z0"). Often printed on IndiaMART/JustDial listings, invoices, or a website's footer/contact page. Null if not found.${isDirectory ? `
- productsServices: this is a directory/marketplace listing (IndiaMART, TradeIndia, JustDial, MagicPin, etc.) — these commonly show a full product list, menu, or catalogue. Capture EVERY distinct product/service/menu item listed, comma-separated, not just a one-line summary.` : ''}

ICP FIT ASSESSMENT — judge fit against MY BUSINESS below, not any assumed industry:
MY BUSINESS: ${businessProfile}
- Assess whether this company fits MY BUSINESS's target customer profile, based ONLY on the evidence above.
- status: "high_fit" = clearly matches MY BUSINESS's target industry and size; "medium_fit" = adjacent industry or borderline size; "low_fit" = possible but unclear; "reject" = unrelated industry OR clearly too small for what MY BUSINESS targets.
${linkedInInstructions}
EVIDENCE FROM ${sourceType.toUpperCase()}:
${evidence}

Return ONLY valid JSON — no markdown. Every string "value" in English; "originalQuote" verbatim from the evidence:
{
  "industry": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "companyType": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "employeeCount": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "annualTurnover": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "yearFounded": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "decisionMakers": [{ "name": null, "designation": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 }],
  "summary": { "value": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "productsServices": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "gstNumber": { "value": null, "originalQuote": null, "sourceUrl": "${sourceUrl}", "confidence": 0 },
  "icpFit": { "status": "low_fit", "reason": "", "confidence": 0 },
  "overallConfidence": 0${linkedInSchema}
}`
}

async function callGemini(prompt: string, apiKey: string, model: string): Promise<EvidenceResponse | null> {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  return match ? JSON.parse(match[0]) as EvidenceResponse : null
}

async function callClaude(prompt: string, apiKey: string, model: string): Promise<EvidenceResponse | null> {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text: string = data?.content?.[0]?.text ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  return match ? JSON.parse(match[0]) as EvidenceResponse : null
}

async function callOpenAi(prompt: string, apiKey: string, model: string): Promise<EvidenceResponse | null> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
      // The schema's top level is an object, so JSON mode is safe here — it
      // guarantees parseable output (no markdown fences / trailing prose).
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text: string = data?.choices?.[0]?.message?.content ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  return match ? JSON.parse(match[0]) as EvidenceResponse : null
}

function fieldVal(f: EvidenceField | undefined): string | undefined {
  if (!f || f.value === null || f.value === undefined) return undefined
  // AI sometimes returns numbers (e.g. year founded as 2010) instead of strings
  const s = String(f.value).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'N/A' || s === 'n/a') return undefined
  return s
}

function quoteVal(f: EvidenceField | EvidencePersonField | undefined): string | undefined {
  if (!f || !('originalQuote' in f) || f.originalQuote === null || f.originalQuote === undefined) return undefined
  const s = String(f.originalQuote).trim()
  return (s && s !== 'null') ? s : undefined
}

// Flatten the nested evidence response into the flat shape the aggregator expects
export function flattenEvidenceResponse(ev: EvidenceResponse, sourceLanguage?: string): FlatExtractedData {
  const primaryDecisionMaker = ev.decisionMakers?.find((d) => d.name && d.name !== 'null')
  const services = fieldVal(ev.productsServices)

  const liVal = (f?: EvidenceField) => {
    if (!f || f.value === null || f.value === undefined) return undefined
    const s = String(f.value).trim()
    return (s && s !== 'null' && s !== 'undefined') ? s : undefined
  }

  // Collect original-language quotes — the untranslated source snippets
  const originalQuotes: Record<string, string> = {}
  const collect = (key: string, f?: EvidenceField | EvidencePersonField) => {
    const q = quoteVal(f)
    if (q) originalQuotes[key] = q
  }
  collect('industry',         ev.industry)
  collect('companyType',      ev.companyType)
  collect('employeeCount',    ev.employeeCount)
  collect('annualTurnover',   ev.annualTurnover)
  collect('yearFounded',      ev.yearFounded)
  collect('productsServices', ev.productsServices)
  collect('gstNumber',        ev.gstNumber)
  collect('decisionMaker',    primaryDecisionMaker)

  // Deterministic normalizers — additions on top, originals preserved
  const turnover = fieldVal(ev.annualTurnover)
  const turnoverNorm = normalizeCurrency(turnover)
  const companyType = fieldVal(ev.companyType)
  const typeNorm = normalizeCompanyType(companyType ?? quoteVal(ev.companyType))
  const roleNorm = normalizeRole(primaryDecisionMaker?.designation ?? undefined)

  return {
    industry:      fieldVal(ev.industry),
    companyType,
    companyTypeNormalized: typeNorm ?? undefined,
    employeeCount: fieldVal(ev.employeeCount),
    annualTurnover: turnover,
    annualTurnoverCurrency: turnoverNorm?.currencyCode ?? undefined,
    annualTurnoverApproxUsd: turnoverNorm?.approxUsd ?? undefined,
    yearFounded:   ev.yearFounded?.value ? parseInt(String(ev.yearFounded.value)) || undefined : undefined,
    decisionMaker: primaryDecisionMaker?.name ?? undefined,
    decisionMakerRole: roleNorm && roleNorm !== 'Other' ? roleNorm : undefined,
    teamMembers:   ev.decisionMakers
      ?.filter((d) => d.name && d.name !== 'null')
      .map((d) => ({ name: d.name!, role: d.designation ?? '' })),
    summary:       fieldVal(ev.summary),
    services:      services ? [services] : undefined,
    gstNumber:     fieldVal(ev.gstNumber),
    icpFit:        ev.icpFit,
    confidence:    ev.overallConfidence ?? 0,
    originalQuotes: Object.keys(originalQuotes).length > 0 ? originalQuotes : undefined,
    sourceLanguage: sourceLanguage && sourceLanguage !== 'en' ? sourceLanguage : undefined,
    // LinkedIn-specific
    linkedinFollowers:   liVal(ev.linkedinFollowers),
    linkedinSpecialties: liVal(ev.linkedinSpecialties)
      ? liVal(ev.linkedinSpecialties)!.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    linkedinAbout: liVal(ev.linkedinAbout),
    linkedinPeople: ev.linkedinPeople
      ?.filter((p) => p.name && p.name !== 'null')
      .map((p) => ({
        name: p.name!,
        title: p.title ?? '',
        profileUrl: (p.profileUrl && p.profileUrl !== 'null') ? p.profileUrl : undefined,
      })),
    linkedinRecentPost: (ev.linkedinRecentPost?.date && ev.linkedinRecentPost.date !== 'null')
      ? { date: ev.linkedinRecentPost.date, snippet: ev.linkedinRecentPost.snippet ?? '' }
      : undefined,
  }
}

export async function extractWithEvidence(
  provider: 'gemini' | 'openai' | 'anthropic',
  companyName: string,
  city: string,
  sourceUrl: string,
  sourceType: string,
  evidence: string,
  apiKey: string,
  model: string,
  businessProfile: string,
  sourceLanguage?: string,
): Promise<FlatExtractedData | null> {
  const prompt = buildEvidencePrompt(companyName, city, sourceUrl, sourceType, evidence, businessProfile, sourceLanguage)

  let raw: EvidenceResponse | null = null
  if (provider === 'gemini')      raw = await callGemini(prompt, apiKey, model)
  else if (provider === 'openai') raw = await callOpenAi(prompt, apiKey, model)
  else                            raw = await callClaude(prompt, apiKey, model)

  if (!raw) return null
  try {
    return flattenEvidenceResponse(raw, sourceLanguage)
  } catch (err: any) {
    console.error('[evidenceExtractor] flattenEvidenceResponse crashed:', err?.message, JSON.stringify(raw).slice(0, 300))
    return null
  }
}
