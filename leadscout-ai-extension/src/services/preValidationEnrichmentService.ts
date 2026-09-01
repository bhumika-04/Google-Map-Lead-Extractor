// Pre-validation company profile enrichment — one AI call per lead.
//
// Primary: Gemini Google Search Grounding (live web data — MCA, IndiaMART, Tofler, etc.)
// Fallback: OpenAI gpt-4o-mini (knowledge-based inference — no live registry lookup,
//           but still gives reliable industry/type/summary for ICP scoring).
//
// Returns: industry, companyType, annualTurnover, employeeCount, CIN, UAN, directors, summary.

import { researchResultRepository } from '@/db/researchResultRepository'
import { leadRepository } from '@/db/leadRepository'
import { searchCompanyWithGeminiGrounding } from './geminiGroundedSearch'
import { searchCompanyWithOpenAi } from './openAiEnrichmentService'
import type { Lead } from '@/types/lead'
import type { AppSettings } from '@/types/settings'

// 1.5s between calls — well within free-tier rate limits
const GROUNDING_DELAY = 1500

interface QuickProfile {
  leadId:                  number
  industry?:               string
  companyType?:            string
  employeeCount?:          string
  employeeCountVerified?:  boolean
  annualTurnover?:         string
  annualTurnoverVerified?: boolean
  decisionMaker?:          string
  summary?:                string
  cin?:                    string
  uan?:                    string
}

export async function runPreValidationEnrichment(
  leads: Lead[],
  settings: AppSettings,
  _apiKey: string,
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean | Promise<boolean>,
  // Fired once the already-enriched leads have been filtered out, so callers
  // can show an accurate "X leads (Y already done, skipping)" message instead
  // of the raw input count — resuming after a Stop looked like it was
  // restarting from scratch because the caller's toast reported the full
  // scope (e.g. 500) instead of what was actually about to run (e.g. 348).
  onScopeResolved?: (toEnrichCount: number, alreadyDoneCount: number) => void,
): Promise<void> {
  const geminiApiKey = settings.geminiApiKey?.trim()
  const geminiModel  = settings.geminiModel || 'gemini-flash-latest'
  const openAiKey    = settings.openAiApiKey?.trim()
  const openAiModel  = settings.openAiModel || 'gpt-4o-mini'

  // Respect an explicit provider choice (e.g. appsettings.json ResearchProvider
  // set to "openai" after Gemini credits ran out) — don't silently prefer
  // Gemini just because a (possibly exhausted) key is still configured.
  const explicitOpenAi = settings.researchProvider === 'openai' && !!openAiKey
  const useGemini = !explicitOpenAi && !!geminiApiKey
  const useOpenAi = !useGemini && !!openAiKey

  if (!useGemini && !useOpenAi) {
    console.warn('[enrichment] ❌ No AI key available — skipping enrichment. Add geminiApiKey or openAiApiKey to appsettings.json.')
    return
  }

  const providerLabel = useGemini ? `Gemini (${geminiModel})` : `OpenAI/${openAiModel} (knowledge-based, no live grounding)`
  console.log(`[enrichment] 🚀 Starting enrichment | provider: ${providerLabel} | leads in: ${leads.length}`)

  // Skip leads that already have a fresh enrichment record (jobId=0)
  const existingResults  = await researchResultRepository.getAll()
  const alreadyEnriched  = new Set(existingResults.filter((r) => r.jobId === 0).map((r) => r.leadId))
  const toEnrich         = leads.filter((l) => l.id && !alreadyEnriched.has(l.id))
  const alreadyDoneCount = leads.length - toEnrich.length

  console.log(`[enrichment] 📋 Leads to enrich: ${toEnrich.length} (${alreadyDoneCount} already done, skipping)`)
  onScopeResolved?.(toEnrich.length, alreadyDoneCount)

  if (toEnrich.length === 0) {
    console.log('[enrichment] ✅ Nothing to do — all leads already enriched.')
    return
  }

  const total = toEnrich.length
  onProgress?.(0, total)   // show the real (reduced) total immediately, not 0/0

  for (let i = 0; i < toEnrich.length; i++) {
    if (shouldStop && await shouldStop()) {
      console.log(`[enrichment] ⏹ Stop requested — halting at ${i}/${total}`)
      break
    }
    const lead = toEnrich[i]
    if (!lead.id) continue

    const profile: QuickProfile = { leadId: lead.id }
    const tag = `[enrichment] [${i + 1}/${total}] "${lead.companyName}" (${lead.city})`

    console.log(`${tag} → calling ${useGemini ? 'Gemini grounding' : 'OpenAI'}...`)

    try {
      const data = useGemini
        ? await searchCompanyWithGeminiGrounding(lead.companyName, lead.city, geminiApiKey!, geminiModel, lead.country ?? 'IN')
        : await searchCompanyWithOpenAi(lead.companyName, lead.city, openAiKey!, openAiModel, lead.country ?? 'IN')
      if (data) {
        profile.industry                = data.industry
        profile.companyType             = data.companyType
        profile.annualTurnover          = data.annualTurnover
        profile.annualTurnoverVerified  = data.annualTurnoverVerified
        profile.employeeCount           = data.employeeCount
        profile.employeeCountVerified   = data.employeeCountVerified
        profile.decisionMaker           = data.directors
        profile.summary                 = data.summary
        profile.cin                     = data.cin
        profile.uan                     = data.uan

        console.log(`${tag} ✅ Got data:`, {
          industry:      profile.industry      ?? '—',
          companyType:   profile.companyType   ?? '—',
          employees:     profile.employeeCount ?? '—',
          turnover:      profile.annualTurnover ?? '—',
          cin:           profile.cin           ?? '—',
          uan:           profile.uan           ?? '—',
          decisionMaker: profile.decisionMaker ?? '—',
        })
      } else {
        console.warn(`${tag} ⚠️ AI returned no data`)
      }
    } catch (err) {
      console.error(`${tag} ❌ AI call failed:`, err)
    }

    // Save enrichment record to researchResultRepository
    const hasData = profile.industry || profile.companyType || profile.employeeCount ||
                    profile.annualTurnover || profile.summary
    if (hasData) {
      await researchResultRepository.create({
        leadId:         profile.leadId,
        jobId:          0,
        industry:       profile.industry,
        companyType:    profile.companyType,
        employeeCount:  profile.employeeCount,
        annualTurnover: profile.annualTurnover,
        decisionMaker:  profile.decisionMaker,
        summary:        profile.summary,
        confidence:     0.8,
      }).catch((e) => console.warn(`${tag} DB write (researchResult) failed:`, e))

      console.log(`${tag} 💾 Saved research result record`)
    } else {
      console.warn(`${tag} ⚠️ No data to save — lead will have empty enrichment fields`)
    }

    // Write ALL enrichment fields directly onto the lead record immediately —
    // so data appears live in the table as each lead completes, not only after
    // the full batch finishes.
    const directPatch: Partial<import('@/types/lead').Lead> = {}
    if (profile.cin)                                   directPatch.cin               = profile.cin
    if (profile.uan)                                   directPatch.uan               = profile.uan
    if (profile.annualTurnoverVerified !== undefined)  directPatch.turnoverVerified  = profile.annualTurnoverVerified
    if (profile.employeeCountVerified  !== undefined)  directPatch.teamSizeVerified  = profile.employeeCountVerified
    if (profile.industry)                              directPatch.industry          = profile.industry
    if (profile.companyType)                           directPatch.companyType       = profile.companyType
    if (profile.employeeCount)                         directPatch.teamSize          = profile.employeeCount
    if (profile.annualTurnover)                        directPatch.annualTurnover    = profile.annualTurnover
    if (profile.decisionMaker)                         directPatch.decisionMaker     = profile.decisionMaker

    if (Object.keys(directPatch).length > 0) {
      await leadRepository.patchMissingFields(profile.leadId, directPatch)
        .catch((e) => console.warn(`${tag} DB patch (lead record) failed:`, e))
      console.log(`${tag} 📝 Patched lead record — fields: ${Object.keys(directPatch).join(', ')}`)
    } else {
      console.warn(`${tag} ⚠️ directPatch is empty — no lead fields written`)
    }

    // Fire after DB write so loadLeads() triggered by caller sees the new data
    onProgress?.(i + 1, total)

    if (i < toEnrich.length - 1) {
      console.log(`${tag} ⏳ Waiting ${GROUNDING_DELAY}ms before next lead...`)
      await new Promise((r) => setTimeout(r, GROUNDING_DELAY))
    }
  }

  console.log(`[enrichment] 🏁 Enrichment complete — ${total} leads processed`)
}
