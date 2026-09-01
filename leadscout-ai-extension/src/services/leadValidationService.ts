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

  return `You are a B2B lead qualification scorer.

The MY BUSINESS description below is the COMPLETE and ONLY source of truth for
this evaluation — if it defines its own rejection rules, scoring dimensions,
or a threshold for what counts as "relevant", follow THOSE exactly. Do not
invent, add, or fall back to any generic rejection rule, scoring dimension,
or threshold that isn't stated in MY BUSINESS. Only if MY BUSINESS does NOT
specify its own relevance threshold, default to: score >= 50 is relevant.

MY BUSINESS:
${businessProfile}

LEADS TO EVALUATE (evaluate independently — do not let one lead's score or
reasoning influence another's):
${leadLines}

For EACH lead, write "reason" as a short explanation SPECIFIC to that exact
lead — reference its actual name, category, or data. Never reuse the same
wording across two different leads, and never copy the example text below
verbatim; it exists only to show the required JSON shape.

Return ONLY a valid JSON array, no markdown, one object per lead in the same
order as listed above:
[
  {
    "leadId": <id>,
    "icpScore": <0-100 integer>,
    "icpStatus": "<short label, e.g. high_fit | good_fit | low_priority | reject>",
    "relevant": <true|false, per MY BUSINESS's own threshold>,
    "reason": "<specific to this one lead>",
    "scoreBreakdown": "<optional short breakdown>"
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

    // Trust the AI's own `relevant` verdict — it was told to apply the
    // business profile's own threshold (which is often NOT 50, e.g. a
    // looser profile using >=40). Hardcoding ">= 50" here silently
    // overrode any custom threshold the profile actually specified. Only
    // fall back to a >=50 default when the AI omits the field entirely.
    const relevant = typeof r.relevant === 'boolean' ? r.relevant : icpScore >= 50

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
