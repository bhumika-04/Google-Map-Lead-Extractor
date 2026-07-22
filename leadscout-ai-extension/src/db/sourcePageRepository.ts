import { db } from './db'
import type { Table } from 'dexie'
import type { SourcePage } from '@/types/searchEvidence'

// NOTE: the `sourcePages` object store was removed in Dexie v8 — Phase 3 data
// (evidence, source pages, merged research) now lives ONLY in MSSQL. These
// methods are guarded so any lingering caller no-ops safely instead of throwing
// on `db.sourcePages` being undefined. Live research progress is published to
// chrome.storage.local (research_activity) by researchService instead.
const store = () => (db as unknown as { sourcePages?: Table<SourcePage, number> }).sourcePages

export const sourcePageRepository = {
  async create(page: Omit<SourcePage, 'id'>): Promise<number | undefined> {
    return store()?.add({ ...page } as SourcePage)
  },
  async getById(id: number): Promise<SourcePage | undefined> {
    return store()?.get(id)
  },
  async getByLeadId(leadId: number): Promise<SourcePage[]> {
    return (await store()?.where('leadId').equals(leadId).toArray()) ?? []
  },
  async getAll(): Promise<SourcePage[]> {
    return (await store()?.toArray()) ?? []
  },
  async update(id: number, changes: Partial<SourcePage>): Promise<void> {
    await store()?.update(id, changes)
  },
  async deleteByLeadId(leadId: number): Promise<void> {
    await store()?.where('leadId').equals(leadId).delete()
  },
}
