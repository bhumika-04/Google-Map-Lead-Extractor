import { db } from './db'
import type { Table } from 'dexie'
import type { PipelineLead, ScrapedLead, ImportedLead } from '@/types/pipelineLead'
import { nowISO } from '@/utils/date'

// Shared repository for the redesigned lead tables. Both `scrapedLeads` and
// `importedLeads` have the same shape, so one factory serves both.

interface LeadStats {
  captured: number
  enriched: number
  validated: number
  relevant: number
  researched: number
}

function makeRepo<T extends PipelineLead>(table: () => Table<T, number>) {
  return {
    async create(lead: Omit<T, 'id' | 'capturedAt' | 'updatedAt'> & Partial<Pick<T, 'capturedAt' | 'updatedAt'>>): Promise<number> {
      const now = nowISO()
      return table().add({ capturedAt: now, updatedAt: now, ...lead } as T)
    },

    async getById(id: number): Promise<T | undefined> {
      return table().get(id)
    },

    async getBySession(sessionId: number): Promise<T[]> {
      return table().where('sessionId').equals(sessionId).toArray()
    },

    async getAll(): Promise<T[]> {
      return table().toArray()
    },

    async update(id: number, patch: Partial<T>): Promise<void> {
      await table().update(id, { ...patch, updatedAt: nowISO() } as Partial<T>)
    },

    async count(sessionId?: number): Promise<number> {
      return sessionId === undefined
        ? table().count()
        : table().where('sessionId').equals(sessionId).count()
    },

    async delete(id: number): Promise<void> {
      await table().delete(id)
    },

    // Upsert on (sessionId + normalizedName) — never clobbers enrichment/validation/
    // research fields already present (mirrors the server's save-batch MERGE).
    async upsertCapture(sessionId: number, leads: Array<Partial<T> & { normalizedName: string; companyName: string }>): Promise<number> {
      let n = 0
      await db.transaction('rw', table(), async () => {
        for (const l of leads) {
          const existing = await table().where('sessionId').equals(sessionId).and((x) => x.normalizedName === l.normalizedName).first()
          if (existing) {
            const { status, notes, tags, ...capture } = l as any
            await table().update(existing.id!, { ...capture, updatedAt: nowISO() } as Partial<T>)
          } else {
            const now = nowISO()
            await table().add({
              status: 'new',
              enrichmentStatus: 'pending',
              researchStatus: 'none',
              capturedAt: now,
              updatedAt: now,
              ...l,
              sessionId,
            } as unknown as T)
          }
          n++
        }
      })
      return n
    },

    // Per-session funnel counts, one pass — matches the workspace KPI row.
    async stats(sessionId: number): Promise<LeadStats> {
      const rows = await this.getBySession(sessionId)
      return {
        captured:   rows.length,
        enriched:   rows.filter((r) => r.enrichmentStatus === 'done').length,
        validated:  rows.filter((r) => r.validationStatus !== undefined).length,
        relevant:   rows.filter((r) => r.validationStatus === 'relevant').length,
        researched: rows.filter((r) => r.researchStatus === 'completed').length,
      }
    },
  }
}

export const scrapedLeadRepo = makeRepo<ScrapedLead>(() => db.scrapedLeads)
export const importedLeadRepo = makeRepo<ImportedLead>(() => db.importedLeads)

export type PipelineLeadRepo = typeof scrapedLeadRepo
