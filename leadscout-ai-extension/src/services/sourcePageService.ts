// Visits a single SearchEvidence link via its source adapter, extracts its
// text, and (separately) runs one AI extraction call scoped to just that
// page's content — keeping every extracted field traceable to the specific
// source it came from. Blocked sources (login walls, captchas, 404s) are
// recorded with a structured reason and skipped — never bypassed.

import { adapterFor } from './sourceAdapters'
import { extractWithEvidence } from './evidenceExtractor'
import { normalizeUrl } from './linkClassifier'
import type { SearchEvidence, SourcePage, DetectedType } from '@/types/searchEvidence'
import { nowISO } from '@/utils/date'

// Source types worth opening, in trust order. review_site is now included
// (low priority); unknown / rejected evidence stays evidence-only.
export const SOURCE_VISIT_PRIORITY: DetectedType[] = [
  'official_website', 'corporate_registry', 'linkedin',
  'company_directory', 'indiamart', 'tradeindia', 'zaubacorp',
  'news', 'facebook', 'instagram', 'youtube', 'review_site', 'ambitionbox',
]

export async function visitSource(evidence: SearchEvidence): Promise<SourcePage> {
  const tag = `[source-page] [${evidence.detectedType}]`
  // Strip aggregator sub-page segments that 404 (e.g. ZoomInfo /clients, RocketReach /services)
  const visitUrl = normalizeUrl(evidence.url)
  if (visitUrl !== evidence.url) {
    console.log(`${tag} 🔗 Normalized URL: ${evidence.url.slice(0, 80)} → ${visitUrl.slice(0, 80)}`)
  }

  const base: Omit<SourcePage, 'id'> = {
    leadId: evidence.leadId,
    evidenceId: evidence.id ?? 0,
    url: visitUrl,
    sourceDomain: evidence.sourceDomain,
    sourceType: evidence.detectedType,
    status: 'pending',
    capturedAt: nowISO(),
  }

  const adapter = adapterFor(evidence.detectedType)
  if (!adapter) {
    console.warn(`${tag} ⚠️ No adapter for type — skipping`)
    return { ...base, status: 'blocked', blockedReason: 'unsupported', errorMessage: `No adapter for ${evidence.detectedType}` }
  }

  console.log(`${tag} 🌐 [${adapter.name}] Fetching: ${visitUrl.slice(0, 80)}`)

  try {
    const result = await adapter.extract(visitUrl)

    if (result.blockedReason) {
      console.warn(`${tag} 🚫 Blocked: ${result.blockedReason} — respecting restriction, moving on`)
      return { ...base, status: 'blocked', blockedReason: result.blockedReason, errorMessage: `Blocked: ${result.blockedReason}` }
    }
    if (!result.ok || !result.rawText) {
      console.warn(`${tag} ⚠️ ${result.errorMessage ?? 'No content'}`)
      return { ...base, status: 'failed', errorMessage: result.errorMessage ?? 'No content fetched' }
    }

    console.log(`${tag} ✅ Fetched: ${result.rawText.length} chars${result.pagesVisited ? ` from ${result.pagesVisited} page(s)` : ''} | lang: ${result.detectedLanguage}`)
    return {
      ...base,
      pageTitle: result.pageTitle,
      rawText: result.rawText,
      detectedLanguage: result.detectedLanguage,
      status: 'fetched',
    }
  } catch (err: any) {
    console.error(`${tag} ❌ Fetch error:`, err?.message)
    return { ...base, status: 'failed', errorMessage: err?.message ?? 'Unknown error' }
  }
}

export async function extractFromSourcePage(
  sourcePage: SourcePage,
  companyName: string,
  city: string,
  provider: 'openai' | 'anthropic' | 'gemini',
  apiKey: string,
  model: string,
  businessProfile: string,
): Promise<SourcePage> {
  const tag = `[source-page] [${sourcePage.sourceType}]`

  if (sourcePage.status !== 'fetched' || !sourcePage.rawText) {
    console.warn(`${tag} ⚠️ Skipping extraction — status: ${sourcePage.status}, hasText: ${!!sourcePage.rawText}`)
    return sourcePage
  }

  console.log(`${tag} 🤖 Extracting with ${provider} | text: ${sourcePage.rawText.length} chars | lang: ${sourcePage.detectedLanguage ?? 'en'}`)

  try {
    let extracted
    try {
      extracted = await extractWithEvidence(
        provider, companyName, city,
        sourcePage.url, sourcePage.sourceType,
        sourcePage.rawText, apiKey, model,
        businessProfile, sourcePage.detectedLanguage,
      )
    } catch (err: any) {
      // One retry on network-level failures ("Failed to fetch") — a transient
      // blip on the AI API call was permanently failing the source, and when
      // it was the lead's only usable source, the whole research job.
      if (!/failed to fetch|network|timed? ?out/i.test(err?.message ?? '')) throw err
      console.warn(`${tag} ⚠️ Network error calling ${provider} — retrying once in 5s…`)
      await new Promise((r) => setTimeout(r, 5000))
      extracted = await extractWithEvidence(
        provider, companyName, city,
        sourcePage.url, sourcePage.sourceType,
        sourcePage.rawText, apiKey, model,
        businessProfile, sourcePage.detectedLanguage,
      )
    }

    if (!extracted) {
      console.warn(`${tag} ⚠️ AI returned no extraction data`)
      return { ...sourcePage, status: 'failed', errorMessage: 'AI extraction returned no data' }
    }

    console.log(`${tag} ✅ Extracted | confidence: ${((extracted.confidence ?? 0) * 100).toFixed(0)}%`, {
      industry:  extracted.industry      ?? '—',
      employees: extracted.employeeCount ?? '—',
      turnover:  extracted.annualTurnover ?? '—',
      email:     extracted.email         ?? '—',
      phone:     extracted.alternatePhone ?? '—',
      lang:      extracted.sourceLanguage ?? 'en',
    })

    return {
      ...sourcePage,
      extractedJson: JSON.stringify(extracted),
      confidence: extracted.confidence ?? 0,
      status: 'extracted',
    }
  } catch (err: any) {
    console.error(`${tag} ❌ Extraction error:`, err?.message)
    return { ...sourcePage, status: 'failed', errorMessage: err?.message ?? 'Extraction error' }
  }
}

export async function visitAndExtract(
  evidence: SearchEvidence,
  companyName: string,
  city: string,
  provider: 'openai' | 'anthropic' | 'gemini',
  apiKey: string,
  model: string,
  businessProfile: string,
): Promise<SourcePage> {
  // No IndexedDB writes — MSSQL is the source of truth for Phase 3 data.
  // All evidence + source pages are batch-saved to MSSQL at end of researchService.processNextJob.
  const base: SourcePage = {
    leadId: evidence.leadId,
    url: evidence.url,
    sourceDomain: evidence.sourceDomain,
    sourceType: evidence.detectedType,
    status: 'pending',
    capturedAt: nowISO(),
  }
  const visited = await visitSource(evidence)
  return extractFromSourcePage({ ...base, ...visited }, companyName, city, provider, apiKey, model, businessProfile)
}
