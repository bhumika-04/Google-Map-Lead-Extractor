// OpenAI-based company enrichment — fallback when Gemini grounding is unavailable.
// Uses knowledge-based inference (no live web search), so financial fields are
// estimated rather than verified. Industry, company type, and summary are reliable.

import type { GroundedCompanyData } from './geminiGroundedSearch'

function clean(v: unknown): string | undefined {
  if (!v || typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a' || s === 'unknown') return undefined
  return s
}

function parseResponse(text: string): GroundedCompanyData | null {
  // Greedy match: from the first { to the LAST } — the lazy version stopped at
  // the first }, truncating any response with nested braces or wrapping text.
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const result: GroundedCompanyData = {
      industry:               clean(raw.industry),
      companyType:            clean(raw.companyType),
      annualTurnover:         clean(raw.annualTurnover),
      annualTurnoverVerified: false,   // never verified without live grounding
      employeeCount:          clean(raw.employeeCount),
      employeeCountVerified:  false,
      cin:                    undefined,
      uan:                    undefined,
      directors:              clean(raw.directors),
      address:                clean(raw.address),
      summary:                clean(raw.summary),
    }
    const hasData = Object.values(result).some(Boolean)
    return hasData ? result : null
  } catch { return null }
}

function buildPrompt(companyName: string, city: string, country: string): string {
  return `You are a B2B company profiler. Based on the company name, city, and your knowledge, infer the following fields.

Company: "${companyName}"
City: ${city}
Country: ${country}

Return ONLY a JSON object (no markdown):
{
  "industry": "the industry sector this company operates in",
  "companyType": "LLC / Pvt Ltd / Sole Proprietorship / Partnership / etc., or null if unknown",
  "annualTurnover": "estimated revenue range in local currency (e.g. ₹1-10 Cr, AED 500K, OMR 50K), or null",
  "employeeCount": "estimated headcount range (e.g. 10-50, 50-200), or null",
  "directors": "owner/founder name if inferable from company name, else null",
  "address": "null",
  "summary": "one sentence describing what this company likely does"
}`
}

export async function searchCompanyWithOpenAi(
  companyName: string,
  city: string,
  apiKey: string,
  model: string,
  country = 'IN',
): Promise<GroundedCompanyData | null> {
  if (!apiKey.trim()) return null

  const prompt = buildPrompt(companyName, city, country)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 512,
        // Guarantees syntactically valid JSON output (the prompt's schema is
        // a flat object, so JSON mode is safe).
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.warn(`[openAiEnrichment] ${companyName}: HTTP ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content ?? ''
    if (!text) return null

    return parseResponse(text)
  } catch (err) {
    console.warn(`[openAiEnrichment] "${companyName}": ${err}`)
    return null
  }
}
