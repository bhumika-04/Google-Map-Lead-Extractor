import type { ResearchJob, ResearchJobType } from '@/types/research'
import type { Lead } from '@/types/lead'
import { researchJobRepository } from '@/db/researchJobRepository'
import { leadRepository } from '@/db/leadRepository'

export async function addToResearchQueue(
  lead: Lead,
  jobType: ResearchJobType = 'company_profile'
): Promise<number> {
  if (!lead.id) throw new Error('Lead must have an id')

  // Prevent duplicate jobs — skip if a pending or running job already exists for this lead
  const existing = await researchJobRepository.getByLead(lead.id)
  const active = existing.find((j) => j.status === 'pending' || j.status === 'running')
  if (active) return active.id!

  const jobId = await researchJobRepository.create({
    leadId: lead.id,
    sessionId: lead.sessionId,
    companyName: lead.companyName,
    jobType,
    status: 'pending',
  })

  await leadRepository.updateStatus(lead.id, 'research_pending')
  return jobId
}

export async function getResearchQueue(): Promise<ResearchJob[]> {
  return researchJobRepository.getPending()
}
