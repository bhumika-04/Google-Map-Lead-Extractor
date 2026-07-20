import { db } from './db'
import type { SearchEvidence } from '@/types/searchEvidence'

export const searchEvidenceRepository = {
  async create(evidence: Omit<SearchEvidence, 'id'>): Promise<number> {
    return db.searchEvidence.add({ ...evidence })
  },

  async bulkCreate(rows: Omit<SearchEvidence, 'id'>[]): Promise<void> {
    await db.searchEvidence.bulkAdd(rows as SearchEvidence[])
  },

  async getById(id: number): Promise<SearchEvidence | undefined> {
    return db.searchEvidence.get(id)
  },

  async getByLeadId(leadId: number): Promise<SearchEvidence[]> {
    return db.searchEvidence.where('leadId').equals(leadId).toArray()
  },

  async getAll(): Promise<SearchEvidence[]> {
    return db.searchEvidence.toArray()
  },

  async update(id: number, changes: Partial<SearchEvidence>): Promise<void> {
    await db.searchEvidence.update(id, changes)
  },

  async deleteByLeadId(leadId: number): Promise<void> {
    await db.searchEvidence.where('leadId').equals(leadId).delete()
  },
}
