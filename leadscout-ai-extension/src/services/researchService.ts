import { researchJobRepository } from '@/db/researchJobRepository'
import { researchResultRepository } from '@/db/researchResultRepository'
import { sourcePageRepository } from '@/db/sourcePageRepository'
import { leadRepository } from '@/db/leadRepository'
import { searchProjectRepository } from '@/db/searchProjectRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import { saveResearchToSql } from './sqlSyncService'
import { savePhase3Data } from './apiResearchService'
import { runGoogleSearchEvidence, isGoogleEvidenceBlocked } from './googleEvidenceService'
import { scrapeGoogleAiCompany } from './googleAiScraper'
import { classifyUrl } from './linkClassifier'
import { extractWithEvidence } from './evidenceExtractor'
import { visitAndExtract, SOURCE_VISIT_PRIORITY } from './sourcePageService'
import { rankAndSelect } from './evidenceRanker'
import { enqueueLiScrape } from './linkedinScraperService'
import { aggregateCompanyResearch, mapToLegacyResearchResult, mergeSourcePages } from './companyResearchAggregator'
import { syncDerivedLeads } from './derivedLeadsService'
import type { SearchEvidence, SourcePage } from '@/types/searchEvidence'
import type { FlatExtractedData } from './evidenceExtractor'
import type { Lead } from '@/types/lead'
import { nowISO } from '@/utils/date'

export interface ResearchServiceConfig {
  researchProvider: 'openai' | 'anthropic' | 'gemini'
  anthropicApiKey: string
  anthropicModel: string
  openAiApiKey: string
  openAiModel: string
  geminiApiKey: string
  geminiModel: string
  /** Drives ICP fit assessment during per-source extraction — see evidenceExtractor.ts */
  businessProfile: string
}

let isProcessing = false

// Publishes live "what's happening right now" for the Research Queue page.
// Phase 3 source data itself is batch-saved to MSSQL at the end of the job —
// this is just the transient dashboard indicator (the old IndexedDB source-page
// rows it used to read were removed when Phase 3 moved to MSSQL-only).
async function setResearchActivity(
  activity: { companyName: string; query?: string; currentSourceUrl?: string; completed: number; failed: number } | null,
): Promise<void> {
  try {
    if (activity === null) await chrome.storage.local.remove('research_activity')
    else await chrome.storage.local.set({ research_activity: activity })
  } catch { /* storage unavailable — the indicator just won't update */ }
}

// Randomized pause between consecutive source visits within one lead's research.
// LinkedIn needs a much longer cooldown — it rate-limits aggressively.
function sourcePause(prevType?: string): Promise<void> {
  const isAfterLinkedIn = prevType === 'linkedin'
  const ms = isAfterLinkedIn
    ? 20000 + Math.random() * 10000   // 20-30s after LinkedIn
    : 3000  + Math.random() * 3000    // 3-6s between all other sources
  if (isAfterLinkedIn) console.log(`[research] ⏸ 20-30s cooldown after LinkedIn visit…`)
  return new Promise((r) => setTimeout(r, ms))
}

// Fixed pause between leads — lets browser breathe and avoids bot detection.
const INTER_LEAD_PAUSE_MS = 30000

function interLeadPause(): Promise<void> {
  console.log(`[research] ⏸ 30s break between leads…`)
  return new Promise((r) => setTimeout(r, INTER_LEAD_PAUSE_MS))
}

function hasValidConfig(config: ResearchServiceConfig): boolean {
  if (config.researchProvider === 'openai')  return !!config.openAiApiKey
  if (config.researchProvider === 'gemini')  return !!config.geminiApiKey
  return !!config.anthropicApiKey
}

function providerCreds(config: ResearchServiceConfig): { apiKey: string; model: string } {
  if (config.researchProvider === 'gemini') return { apiKey: config.geminiApiKey, model: config.geminiModel }
  if (config.researchProvider === 'openai') return { apiKey: config.openAiApiKey, model: config.openAiModel }
  return { apiKey: config.anthropicApiKey, model: config.anthropicModel }
}

export async function processNextJob(config: ResearchServiceConfig): Promise<boolean> {
  if (isProcessing) return false
  if (!hasValidConfig(config)) {
    console.warn('[research] ❌ No valid API key configured — skipping tick')
    return false
  }

  if (isGoogleEvidenceBlocked()) {
    console.log('[research] 🚫 Google blocked — skipping tick, will retry after cooldown')
    return false
  }

  const jobs = await researchJobRepository.getPending()
  if (jobs.length === 0) return false

  const job = jobs[0]
  if (!job.id) return false

  isProcessing = true
  const tag = `[research] "${job.companyName}"`

  try {
    console.log(`${tag} 🚀 Starting job #${job.id} | provider: ${config.researchProvider}`)
    await researchJobRepository.updateStatus(job.id, 'running', { startedAt: nowISO() })
    await setResearchActivity({ companyName: job.companyName, completed: 0, failed: 0 })
    await activityLogRepository.log('research_started', `Research started: ${job.companyName}`, job.sessionId)

    const lead = await leadRepository.getById(job.leadId)
    if (!lead) throw new Error('Lead not found')

    // Use the lead's own Search Session profile for ICP fit assessment —
    // a schools-run lead must be judged against the schools ICP even if the
    // global profile is currently set for a different domain.
    let businessProfile = config.businessProfile
    if (lead.projectId !== undefined) {
      const project = await searchProjectRepository.getById(lead.projectId).catch(() => undefined)
      if (project?.businessProfile?.trim()) businessProfile = project.businessProfile
    }

    const { apiKey, model } = providerCreds(config)
    console.log(`${tag} 🔑 Using model: ${model}`)

    // 0. Google AI-Mode validation search — asks Google's AI for the same
    // fields the OpenAI enrichment prompt covers (turnover, employee count,
    // directors/founders, industry, company type, year founded). Whatever the
    // card/answer actually states VALIDATES the lead's estimated fields
    // (Est. badge → verified ✓), the answer text becomes an extra evidence
    // source, and every URL the answer cites joins the visit list below.
    console.log(`${tag} 🧠 Step 0: Google AI-mode validation search...`)
    const aiValidation = await scrapeGoogleAiCompany(lead.companyName, lead.city, lead.country ?? 'IN').catch(() => null)
    if (aiValidation) {
      const f = aiValidation.fields
      const validatedPatch: Partial<Lead> = {}
      if (f.annualTurnover) { validatedPatch.annualTurnover = f.annualTurnover; validatedPatch.turnoverVerified = true }
      if (f.employeeCount)  { validatedPatch.teamSize = f.employeeCount; validatedPatch.teamSizeVerified = true }
      if (f.directors && !lead.decisionMaker)   validatedPatch.decisionMaker = f.directors
      if (f.cin && !lead.cin)                   validatedPatch.cin = f.cin
      if (f.companyType && !lead.companyType)   validatedPatch.companyType = f.companyType
      if (Object.keys(validatedPatch).length > 0) {
        await leadRepository.updateMany([lead.id!], validatedPatch).catch(() => {})
        console.log(`${tag} ✅ AI-mode validated: ${Object.keys(validatedPatch).join(', ')}`)
      }
      console.log(`${tag} 🧠 AI-mode returned ${aiValidation.urls.length} cited URLs, ${aiValidation.answerText.length} chars of answer text`)
    } else {
      console.log(`${tag} 🧠 AI-mode search returned nothing usable — continuing with organic evidence`)
    }

    // 1. Google search for evidence links
    console.log(`${tag} 🔍 Step 1: Google search evidence...`)
    // Skip the extra LinkedIn site: discovery search when the AI answer
    // already cited a LinkedIn company page — one less Google request (and
    // one less 45s pacing wait) per lead.
    const aiCitedLinkedIn = !!aiValidation?.urls.some((u) => /linkedin\.com\/company\//i.test(u))
    if (aiCitedLinkedIn) console.log(`${tag} 🔗 AI answer already cited a LinkedIn page — skipping site: discovery search`)
    const evidence: SearchEvidence[] = await runGoogleSearchEvidence(
      job.leadId, job.sessionId, lead.companyName, lead.city, lead.country ?? 'IN',
      { skipLinkedInDiscovery: aiCitedLinkedIn },
    )
    console.log(`${tag} 📋 Evidence: ${evidence.length} total | accepted: ${evidence.filter(e => !e.rejected).length} | rejected: ${evidence.filter(e => e.rejected).length}`)
    evidence.forEach((e, i) => {
      console.log(`  ${i + 1}. [${e.detectedType}] ${e.url.slice(0, 80)} | match: ${(e.matchConfidence * 100).toFixed(0)}%${e.rejected ? ` ❌ ${e.rejectReason}` : ' ✅'}`)
    })

    // 1b. Merge the AI answer's cited URLs into the evidence pool — Google's
    // AI chose these as its sources for THIS company's query, so they're
    // high-value visit candidates (deduped against the organic results, and
    // they keep the job alive even when the organic search got soft-blocked).
    if (aiValidation?.urls.length) {
      const capturedAt = nowISO()
      let added = 0
      for (const url of aiValidation.urls) {
        if (evidence.some((e) => e.url === url)) continue
        let sourceDomain = ''
        try { sourceDomain = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
        added++
        evidence.push({
          leadId: job.leadId,
          sessionId: job.sessionId,
          query: 'google-ai-mode',
          queryLanguage: 'en',
          title: lead.companyName,   // cited by the AI answer FOR this company's query
          url,
          displayUrl: sourceDomain,
          snippet: 'Cited by Google AI answer',
          rank: added,
          sourceDomain,
          detectedType: classifyUrl(url),
          matchConfidence: 0.6,
          rejected: false,
          capturedAt,
        })
      }
      if (added > 0) console.log(`${tag} 🧠 Added ${added} AI-cited URLs to the visit pool`)
    }

    if (evidence.length === 0 && isGoogleEvidenceBlocked()) {
      console.warn(`${tag} ⚠️ Google blocked mid-fetch — re-queuing job`)
      await researchJobRepository.updateStatus(job.id, 'pending')
      await activityLogRepository.log('research_paused', `Google blocked — job re-queued: ${job.companyName} (will retry in ~10 min)`, job.sessionId)
      return false
    }

    // 2. Rank evidence by composite score (name match + city/country + local
    //    domain + type trust + phone/address match) and select the visit list.
    const rankCtx = {
      companyName: lead.companyName,
      city: lead.city,
      country: lead.country ?? 'IN',
      phone: lead.phone,
      address: lead.address,
    }
    let toVisitFinal = rankAndSelect(evidence, rankCtx, SOURCE_VISIT_PRIORITY, { maxVisits: 6, maxPerType: 2 })

    // Fallback: if strict match threshold rejected everything but Google did return results,
    // relax the filter and rank all priority-typed links — better to attempt than to fail immediately.
    if (toVisitFinal.length === 0 && evidence.length > 0) {
      console.log(`${tag} ⚠️ All evidence rejected by match threshold — relaxing filter, ranking all priority links`)
      toVisitFinal = rankAndSelect(evidence, rankCtx, SOURCE_VISIT_PRIORITY, { maxVisits: 4, maxPerType: 1, includeRejected: true })
    }

    console.log(`${tag} 🌐 Step 2: Will visit ${toVisitFinal.length} sources (ranked): ${toVisitFinal.map(e => `${e.detectedType}(${e.rankScore})`).join(', ')}`)

    // Clear stale source page rows from a previous attempt for this lead
    await sourcePageRepository.deleteByLeadId(job.leadId).catch(() => {})

    // 3. Visit each accepted link — write live status to IndexedDB so the
    // Research Queue dashboard can display real-time "X completed" counts.
    const sourcePages: SourcePage[] = []

    // 3a. The Google AI answer itself is an evidence source — extract it like
    // any visited page so its turnover / team-size / key-people claims join
    // the aggregation with proper attribution (sourceType 'google_ai').
    if (aiValidation && aiValidation.answerText.length > 300) {
      const aiPendingId = await sourcePageRepository.create({
        leadId: job.leadId, evidenceId: 0,
        url: aiValidation.searchUrl, sourceDomain: 'google.com',
        sourceType: 'google_ai', status: 'pending', capturedAt: nowISO(),
      }).catch(() => undefined)
      try {
        const extracted = await extractWithEvidence(
          config.researchProvider, lead.companyName, lead.city,
          aiValidation.searchUrl, 'google_ai', aiValidation.answerText,
          apiKey, model, businessProfile,
        )
        if (extracted) {
          const aiPage: SourcePage = {
            leadId: job.leadId, evidenceId: 0,
            url: aiValidation.searchUrl, sourceDomain: 'google.com',
            sourceType: 'google_ai',
            rawText: aiValidation.answerText,
            extractedJson: JSON.stringify(extracted),
            confidence: extracted.confidence ?? 0.6,
            status: 'extracted', capturedAt: nowISO(),
          }
          sourcePages.push(aiPage)
          if (aiPendingId !== undefined) {
            await sourcePageRepository.update(aiPendingId, {
              status: 'extracted', extractedJson: aiPage.extractedJson, confidence: aiPage.confidence,
            }).catch(() => {})
          }
          console.log(`${tag} 🧠 AI answer extracted | confidence: ${((aiPage.confidence ?? 0) * 100).toFixed(0)}%`)
        } else if (aiPendingId !== undefined) {
          await sourcePageRepository.update(aiPendingId, { status: 'failed', errorMessage: 'AI answer extraction returned null' }).catch(() => {})
        }
      } catch (err: any) {
        console.warn(`${tag} ⚠️ AI answer extraction failed: ${err?.message}`)
        if (aiPendingId !== undefined) {
          await sourcePageRepository.update(aiPendingId, { status: 'failed', errorMessage: err?.message }).catch(() => {})
        }
      }
    }
    for (let i = 0; i < toVisitFinal.length; i++) {
      const ev = toVisitFinal[i]
      console.log(`${tag} [${i + 1}/${toVisitFinal.length}] 📄 Visiting [${ev.detectedType}]: ${ev.url.slice(0, 80)}`)

      // Publish live progress (current URL + completed/failed) for the Research Queue page
      await setResearchActivity({
        companyName: job.companyName,
        query: evidence[0]?.query,
        currentSourceUrl: ev.url,
        completed: sourcePages.filter((p) => p.status === 'extracted').length,
        failed: sourcePages.filter((p) => p.status === 'failed').length,
      })

      // (Legacy no-op — the sourcePages IndexedDB store was removed in v8; guarded so it can't throw)
      const pendingId = await sourcePageRepository.create({
        leadId:      job.leadId,
        evidenceId:  0,
        url:         ev.url,
        sourceDomain: ev.sourceDomain,
        sourceType:  ev.detectedType,
        status:      'pending',
        capturedAt:  nowISO(),
      }).catch(() => undefined)

      const sp = await visitAndExtract(ev, lead.companyName, lead.city, config.researchProvider, apiKey, model, businessProfile)
      sourcePages.push(sp)

      // Update the IndexedDB row with final status so dashboard reflects it
      if (pendingId !== undefined) {
        await sourcePageRepository.update(pendingId, {
          status:        sp.status,
          pageTitle:     sp.pageTitle,
          extractedJson: sp.extractedJson,
          confidence:    sp.confidence,
          errorMessage:  sp.errorMessage,
        }).catch(() => {})
      }

      if (sp.status === 'extracted') {
        console.log(`${tag} [${i + 1}/${toVisitFinal.length}] ✅ Extracted from [${ev.detectedType}] | confidence: ${((sp.confidence ?? 0) * 100).toFixed(0)}%`)
      } else if (sp.status === 'fetched') {
        console.log(`${tag} [${i + 1}/${toVisitFinal.length}] ⚠️ Fetched but extraction failed [${ev.detectedType}]`)
      } else {
        console.warn(`${tag} [${i + 1}/${toVisitFinal.length}] ❌ Failed [${ev.detectedType}]: ${sp.errorMessage}`)
      }

      if (i < toVisitFinal.length - 1) await sourcePause(ev.detectedType)
    }

    const extractedCount = sourcePages.filter(p => p.status === 'extracted').length
    // sourcePages includes the Google AI answer page in addition to the
    // visited links, so the denominator is sourcePages.length (not the visit
    // count — that made the log read "7/6 sources").
    console.log(`${tag} 📊 Step 3 done: ${extractedCount}/${sourcePages.length} sources extracted`)

    if (sourcePages.every((p) => p.status !== 'extracted')) {
      throw new Error('No usable evidence found (no matching links, or all source visits failed)')
    }

    // 3b. Write LinkedIn-specific data to the lead record so LeadDetailPanel
    // can display it immediately when research completes.
    const linkedInPage = sourcePages.find(
      (p) => p.sourceType === 'linkedin' && p.status === 'extracted' && p.extractedJson,
    )
    if (linkedInPage) {
      const d = JSON.parse(linkedInPage.extractedJson!) as FlatExtractedData
      const linkedInPatch: Partial<Lead> = {}
      // Use the source page URL itself as the LinkedIn URL — d.linkedIn would only
      // be populated if the AI found a LinkedIn link inside another page's text.
      linkedInPatch.linkedinUrl = d.linkedIn ?? linkedInPage.url
      if (d.linkedinFollowers)             linkedInPatch.linkedinFollowers    = d.linkedinFollowers
      if (d.linkedinSpecialties?.length)   linkedInPatch.linkedinSpecialties  = d.linkedinSpecialties.join(', ')
      if (d.linkedinAbout)                 linkedInPatch.linkedinAbout        = d.linkedinAbout
      if (d.linkedinPeople?.length)        linkedInPatch.linkedinPeople       = JSON.stringify(d.linkedinPeople)
      if (d.linkedinRecentPost)            linkedInPatch.linkedinRecentPost   = JSON.stringify(d.linkedinRecentPost)
      if (Object.keys(linkedInPatch).length > 0) {
        await leadRepository.patchMissingFields(lead.id!, linkedInPatch).catch(() => {})
        console.log(
          `${tag} 🔗 LinkedIn data saved: followers=${d.linkedinFollowers ?? '—'}, ` +
          `people=${d.linkedinPeople?.length ?? 0}, specialties=${d.linkedinSpecialties?.length ?? 0}`,
        )
      }
    }

    // 4. Aggregate per-page extractions
    console.log(`${tag} 🔗 Step 4: Aggregating company research...`)
    const companyResearchData = aggregateCompanyResearch(job.leadId, lead.companyName, sourcePages)

    // 5. Map to legacy ResearchResult shape for existing consumers
    const { merged } = mergeSourcePages(sourcePages)
    const sources = sourcePages
      .filter((p) => p.status === 'extracted' || p.status === 'fetched')
      .map((p) => ({ label: p.sourceType, url: p.url }))

    const resultData = mapToLegacyResearchResult(
      merged, job.leadId, job.id, companyResearchData.officialWebsite, sources
    )

    console.log(`${tag} 💾 Step 5: Saving research result | confidence: ${((merged.confidence ?? 0) * 100).toFixed(0)}%`)
    await researchResultRepository.create(resultData)

    saveResearchToSql(lead, resultData).catch(() => {})

    if (lead.mssqlId) {
      console.log(`${tag} 🗄️ Syncing Phase 3 data to MSSQL (mssqlId: ${lead.mssqlId})`)
      savePhase3Data(lead.mssqlId, evidence, sourcePages, companyResearchData).catch(() => {})
    }

    await researchJobRepository.updateStatus(job.id, 'completed', {
      completedAt: nowISO(),
      resultJson: JSON.stringify(merged),
    })

    await leadRepository.updateStatus(lead.id!, 'research_completed')
    syncDerivedLeads().catch(() => {})   // refresh the researched-leads table

    // 6b. Queue the LinkedIn deep-scrape (6-month company posts + every core
    // member's activity) when a company LinkedIn URL was discovered. The
    // service worker drains this queue one company at a time via the RPA
    // scraper — that's where the real 6-month post data comes from, not the
    // single-page fetch above.
    //
    // STRICT: only an ACCEPTED (title-matched) LinkedIn result may trigger the
    // deep-scrape. The relaxed visit fallback can visit a REJECTED linkedin
    // result as a last resort — acceptable for text extraction, but deep-
    // scraping it would RPA-crawl the WRONG company's page. Worse: the same
    // popular wrong page ranks for many small companies' queries, so without
    // this gate the scrape queue fills with the same URL over and over,
    // starving the whole research pipeline behind repeated scrapes of one page.
    const liSlugOf = (u: string) => u.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null
    // Only ORGANIC evidence counts here — AI-citation rows carry a synthetic
    // title (the company name itself), which would trivially pass the title
    // check without any real verification. AI-cited LinkedIn pages still get
    // the normal single-page visit; they just can't trigger the RPA deep-scrape.
    const acceptedLiSlugs = new Set(
      evidence
        .filter((e) => e.detectedType === 'linkedin' && !e.rejected && e.query !== 'google-ai-mode')
        .map((e) => liSlugOf(e.url))
        .filter((s): s is string => !!s)
    )
    const liCompanyUrl = [
      companyResearchData.linkedinUrl,
      linkedInPage?.url,
      ...evidence.filter((e) => e.detectedType === 'linkedin' && !e.rejected).map((e) => e.url),
    ].find((u) => {
      if (!u) return false
      const slug = liSlugOf(u)
      return !!slug && acceptedLiSlugs.has(slug)
    })
    if (liCompanyUrl && lead.id) {
      await enqueueLiScrape({
        leadId: lead.id,
        companyName: lead.companyName,
        linkedInUrl: liCompanyUrl,
        mssqlId: lead.mssqlId,
      }).catch((e) => console.warn(`${tag} LinkedIn queue failed:`, e))
    }

    const discoveredWebsite = resultData.website ?? companyResearchData.officialWebsite
    if (discoveredWebsite && !lead.website) {
      await leadRepository.updateMany([lead.id!], { website: discoveredWebsite })
      console.log(`${tag} 🌐 Discovered website: ${discoveredWebsite}`)
    }

    // Maps list cards give only a fragment ("Shop 34"). Research usually surfaces a
    // fuller address (registered office / directory / AI-mode answer) — write it back
    // when it is more complete than what capture stored, so exports show the full address.
    const researchedAddress = ((companyResearchData as { address?: string }).address || aiValidation?.fields.address || '').trim()
    if (researchedAddress && researchedAddress.length > (lead.address?.trim().length ?? 0)) {
      await leadRepository.updateMany([lead.id!], { address: researchedAddress }).catch(() => {})
      console.log(`${tag} 📍 Address updated from research: ${researchedAddress.slice(0, 80)}`)
    }

    await activityLogRepository.log(
      'research_completed',
      `Research completed: ${job.companyName} via ${config.researchProvider} (confidence: ${Math.round((merged.confidence ?? 0) * 100)}%, ${sourcePages.length} sources visited)`,
      job.sessionId
    )

    console.log(`${tag} 🏁 Job #${job.id} complete | ${sourcePages.length} sources | confidence: ${((merged.confidence ?? 0) * 100).toFixed(0)}%`)

    // 30s break after every lead — lets browser recover and avoids bot-detection
    await interLeadPause()
    return true
  } catch (err: any) {
    const msg = err?.message ?? 'Unknown error'
    console.error(`${tag} ❌ Job failed: ${msg}`, err)
    await researchJobRepository.updateStatus(job.id, 'failed', {
      completedAt: nowISO(),
      errorMessage: msg,
    })
    const lead = await leadRepository.getById(job.leadId).catch(() => null)
    if (lead?.id) await leadRepository.updateStatus(lead.id, 'research_failed')
    await activityLogRepository.log('research_failed', `Research failed: ${job.companyName} — ${msg}`, job.sessionId)
    return false
  } finally {
    await setResearchActivity(null)   // clear the live indicator on every exit path
    isProcessing = false
  }
}
