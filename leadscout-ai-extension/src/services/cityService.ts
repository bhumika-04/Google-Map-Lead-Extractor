import type { AppSettings } from '@/types/settings'
import { resolveAiCredentials } from '@/services/sqlSyncService'

// ─── Dynamic "top N cities" fetcher ──────────────────────────────────────────
// Instead of shipping a hardcoded city list per country (which only ever covered
// a handful of markets and a few dozen cities each), we ask the configured AI
// provider for the top N cities of *any* country on demand — so "Top 500 cities
// in Uganda" or "Top 100 in Dubai/UAE" works the same as India. Results are
// cached in chrome.storage.local so repeat clicks are instant and free.
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const CLAUDE_URL  = 'https://api.anthropic.com/v1/messages'

const CACHE_PREFIX = 'topcities_v1_'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days — city rankings barely change

interface CacheEntry { cities: string[]; fetchedAt: number }

function buildPrompt(countryName: string, count: number): string {
  return `List the top ${count} most significant cities and large towns in ${countryName} for B2B business outreach, ranked by population and commercial importance (most important first).

Rules:
- Return ONLY a compact JSON array of city-name strings in English. No numbering, no commentary, no markdown fences.
- Give up to ${count} distinct, real cities/towns that actually exist in ${countryName}. If ${countryName} has fewer than ${count} notable cities, return only as many as genuinely exist — do NOT pad with fake or duplicate names.
- Use the common English spelling of each city.

Example format: ["City One","City Two","City Three"]`
}

function parseCityList(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  let arr: unknown
  try { arr = JSON.parse(match[0]) } catch { return [] }
  if (!Array.isArray(arr)) return []

  const seen = new Set<string>()
  const out: string[] = []
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const name = v.trim().replace(/^\d+[\.\)]\s*/, '') // strip stray "1. " numbering
    if (!name || name.length > 60) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

async function callOpenAi(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 180)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callGemini(prompt: string, apiKey: string, model: string): Promise<string> {
  const url = `${GEMINI_BASE}/${model || 'gemini-flash-latest'}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 180)}`)
  const data = await res.json()
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function callClaude(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 180)}`)
  const data = await res.json()
  return data?.content?.[0]?.text ?? ''
}

async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const obj = await chrome.storage.local.get(key)
    const entry = obj?.[key] as CacheEntry | undefined
    if (!entry?.cities?.length) return null
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
    return entry
  } catch { return null }
}

async function writeCache(key: string, cities: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: { cities, fetchedAt: Date.now() } satisfies CacheEntry })
  } catch { /* storage quota / unavailable — non-fatal, we just won't cache */ }
}

/**
 * Run a prompt through the configured AI providers and return the first
 * non-empty text response. Prefers OpenAI (explicit product choice), falling
 * back to Gemini then Anthropic using whichever keys are set.
 *
 * @throws if no AI key is configured or every provider fails.
 */
async function runAiText(prompt: string, settings: AppSettings): Promise<string> {
  const attempts: (() => Promise<string>)[] = []
  if (settings.openAiApiKey)    attempts.push(() => callOpenAi(prompt, settings.openAiApiKey, settings.openAiModel))
  if (settings.geminiApiKey)    attempts.push(() => callGemini(prompt, settings.geminiApiKey, settings.geminiModel))
  if (settings.anthropicApiKey) attempts.push(() => callClaude(prompt, settings.anthropicApiKey, settings.anthropicModel))

  // No key in extension settings → fall back to the backend-configured key
  // (DeepLeadApi appsettings.json, served at /api/config). This is where most
  // installs actually keep the key, so validation/research work but these
  // helpers would otherwise silently fail.
  if (attempts.length === 0) {
    const cred = await resolveAiCredentials(settings).catch(() => null)
    if (cred?.apiKey) {
      if (cred.provider === 'openai')         attempts.push(() => callOpenAi(prompt, cred.apiKey, settings.openAiModel))
      else if (cred.provider === 'anthropic') attempts.push(() => callClaude(prompt, cred.apiKey, settings.anthropicModel))
      else                                    attempts.push(() => callGemini(prompt, cred.apiKey, settings.geminiModel))
    }
  }

  if (attempts.length === 0) {
    throw new Error('No AI API key found — set one in Settings → AI Research (or the backend appsettings.json).')
  }

  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      const text = await attempt()
      if (text && text.trim()) return text
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(lastErr instanceof Error ? lastErr.message : 'All AI providers failed')
}

/**
 * Fetch the top `count` cities for a country via the configured AI provider.
 * Cached for 30 days so repeat clicks are instant and free.
 */
export async function fetchTopCities(
  countryCode: string,
  countryName: string,
  count: number,
  settings: AppSettings,
  opts?: { force?: boolean },
): Promise<string[]> {
  const cacheKey = `${CACHE_PREFIX}${countryCode}_${count}`
  if (!opts?.force) {
    const cached = await readCache(cacheKey)
    if (cached) return cached.cities
  }

  const text = await runAiText(buildPrompt(countryName, count), settings)
  const cities = parseCityList(text).slice(0, count)
  if (!cities.length) throw new Error(`No cities returned for ${countryName}`)

  await writeCache(cacheKey, cities)
  return cities
}

// ─── Dynamic keyword synonyms / related search terms ─────────────────────────
const KW_CACHE_PREFIX = 'kwsyn_v1_'

function buildKeywordPrompt(keyword: string, countryName?: string): string {
  return `A B2B lead-generation user is searching Google Maps for businesses using the keyword "${keyword}"${countryName ? ` in ${countryName}` : ''}.

List 10-15 closely-related search terms / business categories that would surface similar or adjacent businesses — include synonyms, sub-types, and related industry terms the user might also want to search.

Rules:
- Return ONLY a compact JSON array of short search-phrase strings. No numbering, no commentary, no markdown fences.
- Each phrase should be 1-4 words and usable as a Google Maps search category. Do NOT repeat "${keyword}" itself.

Example format: ["Offset Printing","Digital Printing","Label Printing"]`
}

/**
 * Fetch 10-15 related keywords / synonyms for a search term via the configured
 * AI provider, so suggestions work for ANY keyword (not just a hardcoded map).
 * Cached per keyword for 30 days.
 */
export async function fetchKeywordSynonyms(
  keyword: string,
  countryName: string | undefined,
  settings: AppSettings,
  opts?: { force?: boolean },
): Promise<string[]> {
  const key = keyword.trim().toLowerCase()
  if (!key) return []

  const cacheKey = `${KW_CACHE_PREFIX}${key}`
  if (!opts?.force) {
    const cached = await readCache(cacheKey)
    if (cached) return cached.cities
  }

  const text = await runAiText(buildKeywordPrompt(keyword.trim(), countryName), settings)
  const terms = parseCityList(text).filter((t) => t.toLowerCase() !== key).slice(0, 15)
  if (!terms.length) throw new Error('No related keywords returned')

  await writeCache(cacheKey, terms)
  return terms
}
