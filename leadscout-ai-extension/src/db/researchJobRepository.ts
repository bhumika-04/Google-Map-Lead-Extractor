import { db } from './db'
import type { ResearchJob, ResearchJobType } from '@/types/research'
import { nowISO } from '@/utils/date'

export const researchJobRepository = {
  async create(job: Omit<ResearchJob, 'id' | 'createdAt'>): Promise<number> {
    return db.researchJobs.add({ ...job, createdAt: nowISO() })
  },

  async getById(id: number): Promise<ResearchJob | undefined> {
    return db.researchJobs.get(id)
  },

  async getAll(): Promise<ResearchJob[]> {
    return db.researchJobs.orderBy('createdAt').reverse().toArray()
  },

  async getByLead(leadId: number): Promise<ResearchJob[]> {
    return db.researchJobs.where('leadId').equals(leadId).toArray()
  },

  async getPending(): Promise<ResearchJob[]> {
    return db.researchJobs.where('status').equals('pending').toArray()
  },

  async updateStatus(id: number, status: ResearchJob['status'], extra?: Partial<ResearchJob>): Promise<void> {
    await db.researchJobs.update(id, { status, ...extra })
  },

  async delete(id: number): Promise<void> {
    await db.researchJobs.delete(id)
  },

  async count(): Promise<number> {
    return db.researchJobs.count()
  },

  async countPending(): Promise<number> {
    return db.researchJobs.where('status').equals('pending').count()
  },
}
