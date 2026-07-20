import { db } from './db'
import type { SourcePage } from '@/types/searchEvidence'

export const sourcePageRepository = {
  async create(page: Omit<SourcePage, 'id'>): Promise<number> {
    return db.sourcePages.add({ ...page })
  },

  async getById(id: number): Promise<SourcePage | undefined> {
    return db.sourcePages.get(id)
  },

  async getByLeadId(leadId: number): Promise<SourcePage[]> {
    return db.sourcePages.where('leadId').equals(leadId).toArray()
  },

  async getAll(): Promise<SourcePage[]> {
    return db.sourcePages.toArray()
  },

  async update(id: number, changes: Partial<SourcePage>): Promise<void> {
    await db.sourcePages.update(id, changes)
  },

  async deleteByLeadId(leadId: number): Promise<void> {
    await db.sourcePages.where('leadId').equals(leadId).delete()
  },
}
