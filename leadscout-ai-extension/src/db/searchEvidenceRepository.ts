import { db } from './db'
import type { Table } from 'dexie'
import type { SearchEvidence } from '@/types/searchEvidence'

// NOTE: the `searchEvidence` object store was removed in Dexie v8 — Phase 3 data
// now lives ONLY in MSSQL. These methods are guarded so any lingering caller
// no-ops safely instead of throwing on `db.searchEvidence` being undefined.
const store = () => (db as unknown as { searchEvidence?: Table<SearchEvidence, number> }).searchEvidence

export const searchEvidenceRepository = {
  async create(evidence: Omit<SearchEvidence, 'id'>): Promise<number | undefined> {
    return store()?.add({ ...evidence } as SearchEvidence)
  },
  async bulkCreate(rows: Omit<SearchEvidence, 'id'>[]): Promise<void> {
    await store()?.bulkAdd(rows as SearchEvidence[])
  },
  async getById(id: number): Promise<SearchEvidence | undefined> {
    return store()?.get(id)
  },
  async getByLeadId(leadId: number): Promise<SearchEvidence[]> {
    return (await store()?.where('leadId').equals(leadId).toArray()) ?? []
  },
  async getAll(): Promise<SearchEvidence[]> {
    return (await store()?.toArray()) ?? []
  },
  async update(id: number, changes: Partial<SearchEvidence>): Promise<void> {
    await store()?.update(id, changes)
  },
  async deleteByLeadId(leadId: number): Promise<void> {
    await store()?.where('leadId').equals(leadId).delete()
  },
}
