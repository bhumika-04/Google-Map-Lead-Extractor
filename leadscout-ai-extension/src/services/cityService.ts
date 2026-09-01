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

const CACHE_PREFIX = 'topcities_v3_'  // bumped: invalidates old single-shot cached lists (now batched)
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days — city rankings barely change

interface CacheEntry { cities: string[]; fetchedAt: number }

function buildPrompt(countryName: string, count: number, exclude: string[] = []): string {
  const continuing = exclude.length > 0
  const head = continuing
    ? `List ${count} MORE cities and large towns in ${countryName} for B2B business outreach — continuing down the list by population and commercial importance, after the ones already listed below. Include tier-2, tier-3 and district towns to reach the count.`
    : `List the top ${count} most significant cities and large towns in ${countryName} for B2B business outreach, ranked by population and commercial importance (most important first).`

  const rules = `

Rules:
- Return ONLY a compact JSON array of city-name strings in English. No numbering, no commentary, no markdown fences.
- Give ${count} distinct, real cities/towns that actually exist in ${countryName}. Do NOT invent fake names or repeat any already-listed city.
- Use the common English spelling of each city.`

  // Bounded exclude list keeps the prompt small; client-side dedup catches the rest.
  const excludeNote = continuing
    ? `\n\nAlready listed — do NOT repeat any of these:\n${exclude.slice(-220).join(', ')}`
    : ''

  return `${head}${rules}${excludeNote}\n\nExample format: ["City One","City Two","City Three"]`
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
 * non-empty text response.
 *
 * appsettings.json (DeepLeadApi backend) is the PRIMARY key source, checked
 * first via resolveAiCredentials — the extension's own Settings-page keys
 * are only used as a fallback when the backend is unreachable or has no key
 * configured. (Previously this checked local Settings keys first, so a
 * stale/wrong key saved once in the extension UI would keep shadowing a
 * perfectly valid backend key forever, failing every call with no obvious
 * cause.)
 *
 * @throws if no AI key is configured or every provider fails.
 */
async function runAiText(prompt: string, settings: AppSettings): Promise<string> {
  const attempts: { name: string; run: () => Promise<string> }[] = []

  const cred = await resolveAiCredentials(settings).catch(() => null)
  console.log(`[cityService] backend provider=${cred?.provider ?? 'none'} hasKey=${!!cred?.apiKey}`)
  if (cred?.apiKey) {
    if (cred.provider === 'openai')         attempts.push({ name: 'openai (resolved)',    run: () => callOpenAi(prompt, cred.apiKey, settings.openAiModel) })
    else if (cred.provider === 'anthropic') attempts.push({ name: 'anthropic (resolved)', run: () => callClaude(prompt, cred.apiKey, settings.anthropicModel) })
    else                                    attempts.push({ name: 'gemini (resolved)',    run: () => callGemini(prompt, cred.apiKey, settings.geminiModel) })
  }

  // Fall back to whatever else is set locally, in case the resolved
  // provider/key above fails at request time (e.g. rate-limited).
  if (settings.openAiApiKey && cred?.provider !== 'openai')       attempts.push({ name: 'openai (local)',    run: () => callOpenAi(prompt, settings.openAiApiKey, settings.openAiModel) })
  if (settings.geminiApiKey && cred?.provider !== 'gemini')       attempts.push({ name: 'gemini (local)',    run: () => callGemini(prompt, settings.geminiApiKey, settings.geminiModel) })
  if (settings.anthropicApiKey && cred?.provider !== 'anthropic') attempts.push({ name: 'anthropic (local)', run: () => callClaude(prompt, settings.anthropicApiKey, settings.anthropicModel) })

  if (attempts.length === 0) {
    throw new Error('No AI API key found — set one in the backend appsettings.json (or Settings → AI Research).')
  }

  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      console.log(`[cityService] calling ${attempt.name}...`)
      const text = await attempt.run()
      if (text && text.trim()) {
        console.log(`[cityService] ${attempt.name} returned ${text.length} chars`)
        return text
      }
      console.warn(`[cityService] ${attempt.name} returned empty response`)
    } catch (err) {
      console.warn(`[cityService] ${attempt.name} failed:`, err instanceof Error ? err.message : err)
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
    if (cached) {
      console.log(`[cityService] fetchTopCities ${countryName} x${count}: CACHE HIT — ${cached.cities.length} cities (delete key "${cacheKey}" in storage to refetch)`)
      return cached.cities
    }
  }

  // Models won't emit a 500-item list in one shot (gpt-4o-mini stops ~130).
  // So we fetch in batches of BATCH, telling the model what it already gave, and
  // merge until we reach `count` or a batch adds nothing new (country exhausted).
  const BATCH = 100
  const collected: string[] = []
  const seen = new Set<string>()
  const maxRounds = Math.ceil(count / BATCH) + 2 // a couple extra to recover short batches

  console.log(`[cityService] fetchTopCities ${countryName}: requesting ${count} cities (batched by ${BATCH})...`)
  for (let round = 0; round < maxRounds && collected.length < count; round++) {
    const want = Math.min(BATCH, count - collected.length)
    let text: string
    try {
      text = await runAiText(buildPrompt(countryName, want, collected), settings)
    } catch (err) {
      console.warn(`[cityService] ${countryName} batch ${round + 1} failed:`, err instanceof Error ? err.message : err)
      break
    }
    let added = 0
    for (const c of parseCityList(text)) {
      const key = c.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(c)
      added++
      if (collected.length >= count) break
    }
    console.log(`[cityService] ${countryName} batch ${round + 1}: requested ${want}, +${added} new, total ${collected.length}/${count}`)
    if (added === 0) { console.log(`[cityService] ${countryName}: model returned no new cities — stopping at ${collected.length}`); break }
  }

  const cities = collected.slice(0, count)
  console.log(`[cityService] fetchTopCities ${countryName}: FINAL ${cities.length} cities (requested ${count})`)
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
