import { db } from './db'
import type { ResearchedLead } from '@/types/derivedLeads'

// Read-only accessors for the dedicated Researched Leads table. Rows are written
// by syncDerivedLeads() (materialized from the master `leads` + researchResults).
export const researchedLeadRepository = {
  async getAll(): Promise<ResearchedLead[]> {
    return db.researchedLeads.toArray()
  },
  async getBySession(projectId: number): Promise<ResearchedLead[]> {
    return db.researchedLeads.where('projectId').equals(projectId).toArray()
  },
  async count(): Promise<number> {
    return db.researchedLeads.count()
  },
  async countBySession(projectId: number): Promise<number> {
    return db.researchedLeads.where('projectId').equals(projectId).count()
  },
}
