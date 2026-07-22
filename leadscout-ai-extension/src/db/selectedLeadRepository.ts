import { db } from './db'
import type { SelectedLead } from '@/types/derivedLeads'

// Read-only accessors for the dedicated Selected Leads table. Rows are written
// by syncDerivedLeads() (materialized from the master `leads` table).
export const selectedLeadRepository = {
  async getAll(): Promise<SelectedLead[]> {
    return db.selectedLeads.toArray()
  },
  async getBySession(projectId: number): Promise<SelectedLead[]> {
    return db.selectedLeads.where('projectId').equals(projectId).toArray()
  },
  async count(): Promise<number> {
    return db.selectedLeads.count()
  },
  async countBySession(projectId: number): Promise<number> {
    return db.selectedLeads.where('projectId').equals(projectId).count()
  },
}
