import { db } from './db'
import type { ResearchResult } from '@/types/research'
import { nowISO } from '@/utils/date'

export const researchResultRepository = {
  async create(result: Omit<ResearchResult, 'id' | 'createdAt'>): Promise<number> {
    return db.researchResults.add({ ...result, createdAt: nowISO() })
  },

  async getByLeadId(leadId: number): Promise<ResearchResult | undefined> {
    return db.researchResults.where('leadId').equals(leadId).last()
  },

  async getByJobId(jobId: number): Promise<ResearchResult | undefined> {
    return db.researchResults.where('jobId').equals(jobId).first()
  },

  async getAll(): Promise<ResearchResult[]> {
    return db.researchResults.toArray()
  },

  async deleteByLeadId(leadId: number): Promise<void> {
    await db.researchResults.where('leadId').equals(leadId).delete()
  },
}
