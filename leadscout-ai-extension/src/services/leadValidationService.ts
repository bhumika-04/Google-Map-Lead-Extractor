import type { Lead } from '@/types/lead'
import { researchResultRepository } from '@/db/researchResultRepository'

export interface ValidationResult {
  leadId: number
  relevant: boolean
  reason: string
  confidence: number  // 0-1, derived from icpScore/100
  icpScore: number    // 0-100 integer ICP score
  icpStatus: string   // 'high_fit' | 'good_fit' | 'low_priority' | 'hold' | 'reject'
  scoreBreakdown?: string  // e.g. "Industry:20 Scale:18 ERP:15 BizType:10 DM:7"
}

export type ValidationProvider = 'gemini' | 'openai' | 'anthropic'

const BATCH_SIZE = 10
const BATCH_DELAY_MS = 20000

// Per-provider fast/cheap models for simple classification
const GEMINI_MODEL   = 'gemini-flash-latest'
const OPENAI_MODEL   = 'gpt-4o-mini'
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

function buildBatchPrompt(
  businessProfile: string,
  leads: { leadId: number; name: string; category: string; city: string; extra?: string }[]
): string {
  const leadLines = leads.map((l, i) =>
    `${i + 1}. ID:${l.leadId} | "${l.name}" | Category: ${l.category || 'Unknown'} | City: ${l.city}${l.extra ? ` | ${l.extra}` : ''}`
  ).join('\n')

  return `You are a B2B lead qualification scorer. Score each lead on a 100-point scale using the 5 dimensions below. Use all available data — company name, category, city, and any enrichment data provided.

The MY BUSINESS description below is the ONLY source of truth for what industries, company types, and customer profile are relevant. Do not assume any specific industry (printing, packaging, or otherwise) beyond what MY BUSINESS actually describes — infer the target customer industry, typical company size, and product/software need entirely from that text.

MY BUSINESS:
${businessProfile}

━━━ HARD REJECT RULES (apply first — if any match, score = 0, relevant = false) ━━━
R1. Industry mismatch: the lead's company/category is clearly NOT in the target industry (or a directly adjacent one) described in MY BUSINESS above.
R2. Excluded type: a single-counter micro retail/service operation with no real production or business operations behind it — not a company MY BUSINESS's product would meaningfully serve.
R3. Too small: Annual Turnover explicitly stated as below ₹1 Crore (e.g. "5 Lakh or Less", "Below 1 Cr", "₹25 Lakh - ₹1 Cr") — or below whatever minimum company size MY BUSINESS specifies, if it specifies one. If turnover is unknown or estimated, do NOT reject on this rule.

━━━ SCORING DIMENSIONS (only if no hard reject) ━━━

DIM 1 — Industry Fit (0–30 pts)
  30 = Exact match: the lead's industry/category is exactly the target customer type described in MY BUSINESS
  20 = Strong adjacent: a closely related industry that MY BUSINESS's product would still clearly serve
  10 = Borderline: allied industry with plausible production/operations relevant to MY BUSINESS
   0 = No clear match (but wasn't hard-rejected above)

DIM 2 — Company Scale (0–25 pts)
  Use Annual Turnover if available, else Employee Count, else estimate from category/context.
  25 = ₹10 Cr+ turnover OR 50+ employees
  18 = ₹1–10 Cr turnover OR 20–50 employees
  10 = Turnover unknown, estimated mid-size (10–20 employees inferred)
   5 = Small but not micro (estimated 6–10 employees)
   0 = Clearly micro / 1–5 employees (do not hard-reject unless R3 applies)

DIM 3 — Product / Software Need (0–25 pts)
  Judge this against whatever MY BUSINESS actually sells (ERP, compliance software, production tools, services, etc.) — not a fixed assumption.
  25 = Clear operational need: the lead's scale/category strongly implies they'd need what MY BUSINESS sells
  15 = Moderate operations: some need likely
   5 = Possible need but unclear from available data
   0 = No apparent need for what MY BUSINESS sells

DIM 4 — Business Type (0–10 pts)
  10 = Manufacturer / producer / plant operator (or MY BUSINESS's ideal operating model)
   5 = Mixed producer + trader/distributor
   0 = Pure trader / distributor / service agency with no production

DIM 5 — Decision Maker Availability (0–10 pts)
  10 = Named decision maker (MD/Owner/Director) known
   5 = Role known but name unknown
   0 = No decision maker info available

━━━ THRESHOLDS ━━━
80–100 = High Priority  → relevant: true
60–79  = Good Lead      → relevant: true
50–59  = Low Priority   → relevant: true, prefix reason with "LOW:"
Below 50 = Reject/Hold  → relevant: false

LEADS TO EVALUATE:
${leadLines}

Return ONLY a valid JSON array, no markdown:
[
  {
    "leadId": <id>,
    "icpScore": 85,
    "icpStatus": "high_fit",
    "relevant": true,
    "reason": "High Priority — exact industry match, 200+ employees, ₹100-500 Cr, clear product need",
    "scoreBreakdown": "Industry:30 Scale:25 Need:20 BizType:5 DM:5"
  },
  {
    "leadId": <id>,
    "icpScore": 0,
    "icpStatus": "reject",
    "relevant": false,
    "reason": "R1: industry unrelated to MY BUSINESS's target customers",
    "scoreBreakdown": "Industry:0 Scale:0 Need:0 BizType:0 DM:0"
  }
]`
}

function icpStatusFromScore(score: number): string {
  if (score >= 80) return 'high_fit'
  if (score >= 60) return 'good_fit'
  if (score >= 50) return 'low_priority'
  if (score > 0)   return 'hold'
  return 'reject'
}

function parseJsonArray(text: string): ValidationResult[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array in response')
  const raw = JSON.parse(match[0]) as Array<Record<string, unknown>>

  return raw.map((r) => {
    // Support both icpScore (new) and confidence (old) — prefer icpScore
    let icpScore: number
    if (typeof r.icpScore === 'number') {
      icpScore = Math.round(Math.max(0, Math.min(100, r.icpScore)))
    } else if (typeof r.confidence === 'number') {
      // Old format: confidence is 0-1, convert to 0-100
      icpScore = Math.round(Math.max(0, Math.min(100, (r.confidence as number) * 100)))
    } else {
      icpScore = 0
    }

    const icpStatus = (typeof r.icpStatus === 'string' && r.icpStatus)
      ? r.icpStatus
      : icpStatusFromScore(icpScore)

    const relevant = icpScore >= 50 && r.relevant !== false

    // Providers occasionally return leadId as a numeric STRING ("1234" instead
    // of 1234) even though the prompt shows it as a bare number — the old
    // strict `typeof === 'number'` check silently dropped those to 0, which
    // meant every validation result for that batch got written to a
    // nonexistent lead id 0 instead of the real lead. Real leads never got
    // their validationStatus/icpScore updated even though the AI scored them
    // correctly — the funnel's Relevant count stayed frozen while results kept
    // coming back. Accept a numeric string too.
    let leadId = 0
    if (typeof r.leadId === 'number' && Number.isFinite(r.leadId)) {
      leadId = r.leadId
    } else if (typeof r.leadId === 'string' && r.leadId.trim() && !Number.isNaN(Number(r.leadId))) {
      leadId = Number(r.leadId)
    } else {
      console.warn('[leadValidation] Could not parse leadId from AI response — result will be dropped:', r.leadId, r)
    }

    return {
      leadId,
      relevant,
      reason:         typeof r.reason === 'string' ? r.reason : '',
      confidence:     icpScore / 100,
      icpScore,
      icpStatus,
      scoreBreakdown: typeof r.scoreBreakdown === 'string' ? r.scoreBreakdown : undefined,
    }
  })
}

async function callGeminiBatch(prompt: string, apiKey: string): Promise<ValidationResult[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini API ${response.status}: ${err}`)
  }
  const data = await response.json()
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return parseJsonArray(text)
}

async function callOpenAiBatch(prompt: string, apiKey: string): Promise<ValidationResult[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      // 10 leads × (reason + breakdown) can exceed 2048 tokens — a truncated
      // array fails JSON.parse and the whole batch fails as "non-retryable".
      max_tokens: 4096,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI API ${response.status}: ${err}`)
  }
  const data = await response.json()
  const text: string = data?.choices?.[0]?.message?.content ?? ''
  return parseJsonArray(text)
}

async function callAnthropicBatch(prompt: string, apiKey: string): Promise<ValidationResult[]> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API ${response.status}: ${err}`)
  }
  const data = await response.json()
  const text: string = data?.content?.[0]?.text ?? ''
  return parseJsonArray(text)
}

async function callBatch(
  prompt: string,
  provider: ValidationProvider,
  apiKey: string,
): Promise<ValidationResult[]> {
  if (provider === 'openai')    return callOpenAiBatch(prompt, apiKey)
  if (provider === 'anthropic') return callAnthropicBatch(prompt, apiKey)
  return callGeminiBatch(prompt, apiKey)
}

// Thrown when the API key's daily quota is exhausted — retrying won't help until tomorrow
export class DailyQuotaExhaustedError extends Error {
  constructor() {
    super('Daily API quota exhausted. Please try again tomorrow or upgrade your API plan.')
    this.name = 'DailyQuotaExhaustedError'
  }
}

async function callBatchWithRetry(
  prompt: string,
  provider: ValidationProvider,
  apiKey: string,
  maxRetries = 2,
): Promise<ValidationResult[]> {
  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callBatch(prompt, provider, apiKey)
    } catch (err: any) {
      lastErr = err
      const msg: string = err?.message ?? ''

      const is429 = msg.includes('429')
      // 500/502/503/504 are all transient upstream/gateway errors (e.g. a
      // Cloudflare 504 in front of api.openai.com under load) — retryable,
      // not permanent failures. Only 504 was actually seen in practice, but
      // its siblings fail the exact same way and deserve the same treatment.
      const isGatewayError = /\b(500|502|503|504)\b/.test(msg)
      if (!is429 && !isGatewayError) throw err  // non-retryable (404, auth error, etc.)

      // Quota/credits exhausted — retrying won't help, fail immediately
      if (
        msg.includes('PerDay') || msg.includes('per_day') ||
        msg.includes('exceeded your current quota') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('credits are depleted') ||
        msg.includes('prepayment')
      ) {
        throw new DailyQuotaExhaustedError()
      }

      if (attempt === maxRetries) break

      const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)/)
      const apiSuggestedSecs = retryMatch ? parseFloat(retryMatch[1]) : 0
      const waitMs = is429
        ? Math.max(apiSuggestedSecs + 5, 35) * 1000
        : Math.max(apiSuggestedSecs + 5, 10) * 1000

      const label = is429 ? '429' : (msg.match(/\b(500|502|503|504)\b/)?.[1] ?? 'gateway error')
      console.warn(`[leadValidation] Attempt ${attempt + 1} failed (${label}), retrying in ${waitMs / 1000}s…`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }

  throw lastErr
}

export async function validateLeads(
  leads: Lead[],
  businessProfile: string,
  apiKey: string,
  provider: ValidationProvider,
  onProgress: (done: number, total: number, batch: ValidationResult[]) => void
): Promise<ValidationResult[]> {
  const allResults = await researchResultRepository.getAll()
  const researchMap = new Map(allResults.map((r) => [r.leadId, r]))

  const allValidations: ValidationResult[] = []
  const total = leads.length

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE)

    const batchInput = batch.map((lead) => {
      const research = lead.id ? researchMap.get(lead.id) : undefined
      // Use lead-level enrichment fields (denormalized) — fall back to research record
      const teamSize       = lead.teamSize ?? research?.employeeCount
      const turnover       = lead.annualTurnover ?? research?.annualTurnover
      const industry       = lead.industry ?? research?.industry
      const summary        = research?.summary
      const decisionMaker  = lead.decisionMaker ?? research?.decisionMaker

      const extra = [
        industry       ? `Industry: ${industry}` : null,
        summary        ? `Summary: ${summary.slice(0, 120)}` : null,
        teamSize       ? `Employees: ${teamSize}${lead.teamSizeVerified === false ? ' (estimated)' : lead.teamSizeVerified ? ' (verified)' : ''}` : null,
        turnover       ? `Annual Turnover: ${turnover}${lead.turnoverVerified === false ? ' (estimated)' : lead.turnoverVerified ? ' (verified)' : ''}` : null,
        decisionMaker  ? `Decision Maker: ${decisionMaker}` : null,
        lead.companyType ? `Company Type: ${lead.companyType}` : null,
        lead.cin       ? `CIN: ${lead.cin}` : null,
      ].filter(Boolean).join(' | ') || undefined

      return {
        leadId:   lead.id!,
        name:     lead.companyName,
        category: lead.category ?? lead.keyword ?? '',
        city:     lead.city,
        extra,
      }
    })

    const prompt = buildBatchPrompt(businessProfile, batchInput)

    try {
      const results = await callBatchWithRetry(prompt, provider, apiKey)
      allValidations.push(...results)
      onProgress(Math.min(i + BATCH_SIZE, total), total, results)
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) throw err
      console.error(`[leadValidation] Batch ${Math.floor(i / BATCH_SIZE) + 1} permanently failed:`, err)
      onProgress(Math.min(i + BATCH_SIZE, total), total, [])
    }

    if (i + BATCH_SIZE < leads.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return allValidations
}
