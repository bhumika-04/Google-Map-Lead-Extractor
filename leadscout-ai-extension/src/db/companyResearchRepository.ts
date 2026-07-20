import { db } from './db'
import type { CompanyResearch } from '@/types/searchEvidence'
import { nowISO } from '@/utils/date'

export const companyResearchRepository = {
  async create(research: Omit<CompanyResearch, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const now = nowISO()
    return db.companyResearch.add({ ...research, createdAt: now, updatedAt: now })
  },

  async getById(id: number): Promise<CompanyResearch | undefined> {
    return db.companyResearch.get(id)
  },

  async getByLeadId(leadId: number): Promise<CompanyResearch | undefined> {
    return db.companyResearch.where('leadId').equals(leadId).last()
  },

  async getAll(): Promise<CompanyResearch[]> {
    return db.companyResearch.toArray()
  },

  async update(id: number, changes: Partial<CompanyResearch>): Promise<void> {
    await db.companyResearch.update(id, { ...changes, updatedAt: nowISO() })
  },

  async deleteByLeadId(leadId: number): Promise<void> {
    await db.companyResearch.where('leadId').equals(leadId).delete()
  },
}
