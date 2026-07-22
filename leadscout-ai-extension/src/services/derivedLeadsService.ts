// Materializes the dedicated per-stage tables (selectedLeads, researchedLeads)
// from the master `leads` table. `leads` is the single source of truth; these
// tables are rebuildable projections, so running this can never lose data — it
// clears and rebuilds both from the current leads + research results.
//
// Called on dashboard load and after the operations that change a lead's stage
// (validation, import, research completion), so the two tables stay in sync.

import { db } from '@/db/db'
import type { SelectedLead, ResearchedLead } from '@/types/derivedLeads'
import type { ResearchResult } from '@/types/research'
import { nowISO } from '@/utils/date'

const isResearch = (s: string) => s.startsWith('research')

export async function syncDerivedLeads(): Promise<void> {
  try {
    const [leads, results] = await Promise.all([db.leads.toArray(), db.researchResults.toArray()])
    const resultByLead = new Map<number, ResearchResult>()
    for (const r of results) if (r.leadId !== undefined) resultByLead.set(r.leadId, r)

    const now = nowISO()
    const selected: SelectedLead[] = []
    const researched: ResearchedLead[] = []

    for (const l of leads) {
      if (l.id === undefined) continue

      const isSelected = l.status === 'selected' || isResearch(l.status) || l.validationStatus === 'relevant'
      if (isSelected) {
        selected.push({
          leadId: l.id,
          projectId: l.projectId,
          companyName: l.companyName,
          city: l.city,
          phone: l.phone,
          website: l.website,
          category: l.category,
          rating: l.rating,
          icpScore: l.icpScore,
          icpStatus: l.icpStatus,
          status: l.status,
          validationReason: l.validationReason ?? l.icpReason,
          selectedAt: l.updatedAt ?? now,
        })
      }

      if (l.status === 'research_completed') {
        const r = resultByLead.get(l.id)
        researched.push({
          leadId: l.id,
          projectId: l.projectId,
          companyName: l.companyName,
          city: l.city,
          decisionMaker: l.decisionMaker ?? r?.decisionMaker,
          email: r?.email,
          phone: l.phone ?? r?.alternatePhone,
          website: l.website ?? r?.website,
          industry: l.industry ?? r?.industry,
          annualTurnover: l.annualTurnover ?? r?.annualTurnover,
          teamSize: l.teamSize ?? r?.employeeCount,
          confidence: r?.confidence,
          researchedAt: l.updatedAt ?? now,
        })
      }
    }

    await db.transaction('rw', db.selectedLeads, db.researchedLeads, async () => {
      await db.selectedLeads.clear()
      if (selected.length) await db.selectedLeads.bulkPut(selected)
      await db.researchedLeads.clear()
      if (researched.length) await db.researchedLeads.bulkPut(researched)
    })
  } catch (err) {
    console.warn('[derivedLeads] sync failed:', err)
  }
}
