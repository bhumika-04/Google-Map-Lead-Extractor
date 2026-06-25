import { researchJobRepository } from '@/db/researchJobRepository'
import { researchResultRepository } from '@/db/researchResultRepository'
import { leadRepository } from '@/db/leadRepository'
import { activityLogRepository } from '@/db/activityLogRepository'
import {
  fetchWebsiteText,
  fetchGoogleSearchData,
  fetchIndiaMartData,
  fetchJustDialData,
  buildCompanyContext,
} from './websiteFetcher'
import { callClaudeResearch, buildResearchResult as buildClaudeResult } from './claudeResearch'
import { callOpenAiResearch, buildResearchResult as buildOpenAiResult } from './openAiResearch'
import { callGeminiResearch, buildResearchResult as buildGeminiResult } from './geminiResearch'
import { nowISO } from '@/utils/date'

export interface ResearchServiceConfig {
  researchProvider: 'openai' | 'anthropic' | 'gemini'
  anthropicApiKey: string
  anthropicModel: string
  openAiApiKey: string
  openAiModel: string
  geminiApiKey: string
  geminiModel: string
}

let isProcessing = false

function hasValidConfig(config: ResearchServiceConfig): boolean {
  if (config.researchProvider === 'openai')  return !!config.openAiApiKey
  if (config.researchProvider === 'gemini')  return !!config.geminiApiKey
  return !!config.anthropicApiKey
}

export async function processNextJob(config: ResearchServiceConfig): Promise<boolean> {
  if (isProcessing) return false
  if (!hasValidConfig(config)) return false

  const jobs = await researchJobRepository.getPending()
  if (jobs.length === 0) return false

  const job = jobs[0]
  if (!job.id) return false

  isProcessing = true

  try {
    await researchJobRepository.updateStatus(job.id, 'running', { startedAt: nowISO() })
    await activityLogRepository.log('research_started', `Research started: ${job.companyName}`, job.sessionId)

    const lead = await leadRepository.getById(job.leadId)
    if (!lead) throw new Error('Lead not found')

    // Fetch all sources in parallel to maximise data collected
    const [initialWebsiteResult, googleResult, indiaMartText, justDialText] = await Promise.all([
      lead.website ? fetchWebsiteText(lead.website) : Promise.resolve(null),
      fetchGoogleSearchData(lead.companyName, lead.city),
      fetchIndiaMartData(lead.companyName, lead.city),
      fetchJustDialData(lead.companyName, lead.city),
    ])

    // If lead has no website but Google discovered one, fetch it now.
    // This is critical — many leads scraped from Maps have no website captured,
    // but Google finds their actual site (e.g. "gphbooks.com" for "Gupta Publishing House").
    let websiteResult = initialWebsiteResult
    if (!websiteResult && googleResult?.discoveredWebsite) {
      websiteResult = await fetchWebsiteText(googleResult.discoveredWebsite)
    }

    const googleData    = googleResult?.text ?? null
    const websiteText   = websiteResult?.text ?? null
    const sourceUrl     = websiteResult?.finalUrl
    const socialUrls    = websiteResult?.socialUrls ?? {}
    const websiteEmails = websiteResult?.emails ?? []

    const context = buildCompanyContext(
      lead.companyName, lead.city, lead.keyword,
      websiteText, socialUrls, websiteEmails,
      googleData, indiaMartText, justDialText,
    )

    let extracted: Awaited<ReturnType<typeof callClaudeResearch>> = null
    let resultData: ReturnType<typeof buildClaudeResult>

    if (config.researchProvider === 'gemini') {
      extracted = await callGeminiResearch(lead.companyName, lead.city, context, config.geminiApiKey, config.geminiModel)
      if (!extracted) throw new Error('Gemini returned no data')
      resultData = buildGeminiResult(job.leadId, job.id, extracted, sourceUrl)
    } else if (config.researchProvider === 'openai') {
      extracted = await callOpenAiResearch(context, config.openAiApiKey, config.openAiModel)
      if (!extracted) throw new Error('OpenAI returned no data')
      resultData = buildOpenAiResult(job.leadId, job.id, extracted, sourceUrl)
    } else {
      extracted = await callClaudeResearch(context, config.anthropicApiKey, config.anthropicModel)
      if (!extracted) throw new Error('Claude returned no data')
      resultData = buildClaudeResult(job.leadId, job.id, extracted, sourceUrl)
    }

    await researchResultRepository.create(resultData)

    await researchJobRepository.updateStatus(job.id, 'completed', {
      completedAt: nowISO(),
      resultJson: JSON.stringify(extracted),
    })

    await leadRepository.updateStatus(lead.id!, 'research_completed')

    // If research discovered a website that wasn't on the lead, update the lead's website field.
    // This fills the "Website" column in Lead Database for leads captured without a website from Maps.
    const discoveredWebsite = resultData.website ?? websiteResult?.finalUrl
    if (discoveredWebsite && !lead.website) {
      await leadRepository.updateMany([lead.id!], { website: discoveredWebsite })
    }

    await activityLogRepository.log(
      'research_completed',
      `Research completed: ${job.companyName} via ${config.researchProvider} (confidence: ${Math.round((extracted.confidence ?? 0) * 100)}%)`,
      job.sessionId
    )

    return true
  } catch (err: any) {
    const msg = err?.message ?? 'Unknown error'
    await researchJobRepository.updateStatus(job.id, 'failed', {
      completedAt: nowISO(),
      errorMessage: msg,
    })
    const lead = await leadRepository.getById(job.leadId).catch(() => null)
    if (lead?.id) await leadRepository.updateStatus(lead.id, 'research_failed')
    await activityLogRepository.log('research_failed', `Research failed: ${job.companyName} — ${msg}`, job.sessionId)
    return false
  } finally {
    isProcessing = false
  }
}
