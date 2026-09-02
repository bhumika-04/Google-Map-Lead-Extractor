import { leadRepository } from '@/db/leadRepository'
import { scrapeGoogleAiCompany } from './googleAiScraper'
import type { Lead } from '@/types/lead'

// On-demand "Verify from Google" — runs a Google AI-mode search per lead to
// replace ESTIMATED turnover / team size with EXACT, verified values (AI mode
// aggregates MCA / Tofler / IndiaMART). Slow (one paced Google tab per lead), so
// it's user-triggered, not part of the fast enrichment step.

export async function verifyLeadsFromGoogle(
  leads: Lead[],
  opts?: {
    onProgress?: (done: number, total: number) => void
    shouldStop?: () => boolean | Promise<boolean>
  },
): Promise<number> {
  const shouldStop = opts?.shouldStop ?? (async () => false)
  let done = 0
  let updated = 0

  for (const lead of leads) {
    if (await shouldStop()) break
    if (!lead.id) { done++; continue }

    try {
      const data = await scrapeGoogleAiCompany(lead.companyName, lead.city, lead.country ?? 'IN')
      const f = data?.fields
      if (f) {
        const patch: Partial<Lead> = {}
        // Exact values from Google AI mode → mark verified, overwrite estimates.
        // Snapshot the pre-verification estimate (once — first verification only,
        // so a re-verify doesn't clobber the original estimate with a value that
        // was itself already verified) so the Verified tab can show both side by side.
        if (f.annualTurnover) {
          if (!lead.turnoverVerified && lead.annualTurnover) patch.annualTurnoverEstimate = lead.annualTurnover
          patch.annualTurnover = f.annualTurnover
          patch.turnoverVerified = true
        }
        if (f.employeeCount) {
          if (!lead.teamSizeVerified && lead.teamSize) patch.teamSizeEstimate = lead.teamSize
          patch.teamSize = f.employeeCount
          patch.teamSizeVerified = true
        }
        if (f.directors)      patch.decisionMaker = f.directors
        if (f.companyType)    patch.companyType = f.companyType
        if (f.cin)            patch.cin = f.cin
        if (f.address)        patch.address = f.address
        if (Object.keys(patch).length) {
          await leadRepository.updateMany([lead.id], patch)
          updated++
        }
      }
    } catch (err) {
      console.warn(`[verify] "${lead.companyName}" failed:`, err)
    }

    done++
    opts?.onProgress?.(done, leads.length)
  }

  return updated
}
