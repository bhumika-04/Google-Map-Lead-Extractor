import type { Lead } from '@/types/lead'
import { researchResultRepository } from '@/db/researchResultRepository'

export interface ValidationResult {
  leadId: number
  relevant: boolean
  reason: string
  confidence: number
}

export type ValidationProvider = 'gemini' | 'openai' | 'anthropic'

const BATCH_SIZE = 10
const BATCH_DELAY_MS = 20000

// Per-provider fast/cheap models for simple classification
const GEMINI_MODEL   = 'gemini-2.0-flash-lite'
const OPENAI_MODEL   = 'gpt-4o-mini'
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

function buildBatchPrompt(
  businessProfile: string,
  leads: { leadId: number; name: string; category: string; city: string; extra?: string }[]
): string {
  const leadLines = leads.map((l, i) =>
    `${i + 1}. ID:${l.leadId} | "${l.name}" | Category: ${l.category || 'Unknown'} | City: ${l.city}${l.extra ? ` | ${l.extra}` : ''}`
  ).join('\n')

  return `You are a B2B lead qualification expert. Evaluate each company below and decide if it is a relevant sales prospect for the given business.

MY BUSINESS:
${businessProfile}

LEADS TO EVALUATE:
${leadLines}

For each lead, decide:
- relevant: true if this company would likely need or benefit from what my business offers
- relevant: false if this company is clearly not a fit (wrong industry, too small, retail/consumer shop, irrelevant category)
- reason: one short sentence explaining why (e.g. "Printing factory — ERP for production fits well" or "Stationary retail shop — no manufacturing, not a fit")
- confidence: 0.0 to 1.0

Return ONLY a valid JSON array, no markdown:
[
  {"leadId": <id>, "relevant": true, "reason": "...", "confidence": 0.9},
  {"leadId": <id>, "relevant": false, "reason": "...", "confidence": 0.85}
]`
}

function parseJsonArray(text: string): ValidationResult[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array in response')
  return JSON.parse(match[0]) as ValidationResult[]
}

async function callGeminiBatch(prompt: string, apiKey: string): Promise<ValidationResult[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
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
      max_tokens: 2048,
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
      max_tokens: 2048,
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
      const is503 = msg.includes('503')
      if (!is429 && !is503) throw err  // non-retryable (404, auth error, etc.)

      // Daily quota exhausted — no point retrying today
      if (msg.includes('PerDay') || msg.includes('per_day') || msg.includes('exceeded your current quota')) {
        throw new DailyQuotaExhaustedError()
      }

      if (attempt === maxRetries) break

      const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)/)
      const apiSuggestedSecs = retryMatch ? parseFloat(retryMatch[1]) : 0
      const waitMs = is429
        ? Math.max(apiSuggestedSecs + 5, 35) * 1000
        : Math.max(apiSuggestedSecs + 5, 10) * 1000

      console.warn(`[leadValidation] Attempt ${attempt + 1} failed (${is429 ? '429' : '503'}), retrying in ${waitMs / 1000}s…`)
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
      const extra = research
        ? [
            research.industry     ? `Industry: ${research.industry}` : null,
            research.summary      ? `Summary: ${research.summary.slice(0, 120)}` : null,
            research.employeeCount ? `Employees: ${research.employeeCount}` : null,
          ].filter(Boolean).join(' | ')
        : undefined

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
