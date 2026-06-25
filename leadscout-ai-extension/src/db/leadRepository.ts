import { db } from './db'
import type { Lead, LeadStatus, LeadFilter } from '@/types/lead'
import { nowISO } from '@/utils/date'
import { normalizeLeadName } from '@/utils/dedupe'

export const leadRepository = {
  async create(lead: Omit<Lead, 'id'>): Promise<number> {
    return db.leads.add(lead)
  },

  async getById(id: number): Promise<Lead | undefined> {
    return db.leads.get(id)
  },

  async getAll(): Promise<Lead[]> {
    return db.leads.orderBy('capturedAt').reverse().toArray()
  },

  async getBySession(sessionId: number): Promise<Lead[]> {
    return db.leads.where('sessionId').equals(sessionId).toArray()
  },

  async getByFilter(filter: LeadFilter): Promise<Lead[]> {
    let collection = db.leads.toCollection()
    if (filter.sessionId !== undefined) {
      collection = db.leads.where('sessionId').equals(filter.sessionId)
    } else if (filter.status) {
      collection = db.leads.where('status').equals(filter.status)
    }
    const results = await collection.toArray()
    return results.filter((l) => {
      if (filter.city && l.city.toLowerCase() !== filter.city.toLowerCase()) return false
      if (filter.keyword && l.keyword.toLowerCase() !== filter.keyword.toLowerCase()) return false
      if (filter.status && l.status !== filter.status) return false
      if (filter.minRating !== undefined && (l.rating === undefined || l.rating < filter.minRating)) return false
      if (filter.hasPhone === true && !l.phone) return false
      if (filter.hasPhone === false && !!l.phone) return false
      if (filter.hasWebsite === true && !l.website) return false
      if (filter.hasWebsite === false && !!l.website) return false
      if (filter.tag && !(l.tags ?? []).includes(filter.tag)) return false
      if (filter.hideNotRelevant && l.validationStatus === 'not_relevant') return false
      return true
    })
  },

  async findCandidatesForDedupe(
    sessionId: number,
    normalizedName: string,
    phone?: string,
    googleMapsUrl?: string
  ): Promise<Lead[]> {
    const candidates: Lead[] = []
    if (googleMapsUrl) {
      const byUrl = await db.leads.where('googleMapsUrl').equals(googleMapsUrl).toArray()
      candidates.push(...byUrl)
    }
    if (phone) {
      const byPhone = await db.leads.where('phone').equals(phone).toArray()
      candidates.push(...byPhone)
    }
    const byName = await db.leads.where('normalizedName').equals(normalizedName).toArray()
    candidates.push(...byName)
    // Deduplicate the candidates array itself
    const seen = new Set<number>()
    return candidates.filter((l) => {
      if (l.id === undefined || seen.has(l.id)) return false
      seen.add(l.id)
      return true
    })
  },

  async updateStatus(id: number, status: LeadStatus): Promise<void> {
    await db.leads.update(id, { status, updatedAt: nowISO() })
  },

  async updateNotes(id: number, notes: string): Promise<void> {
    await db.leads.update(id, { notes, updatedAt: nowISO() })
  },

  async updateTags(id: number, tags: string[]): Promise<void> {
    await db.leads.update(id, { tags, updatedAt: nowISO() })
  },

  async updateValidation(id: number, status: 'relevant' | 'not_relevant' | 'pending', reason?: string): Promise<void> {
    await db.leads.update(id, { validationStatus: status, validationReason: reason, updatedAt: nowISO() })
  },

  async bulkUpdateValidation(results: { id: number; status: 'relevant' | 'not_relevant'; reason: string }[]): Promise<void> {
    const now = nowISO()
    await db.transaction('rw', db.leads, async () => {
      for (const r of results) {
        await db.leads.update(r.id, { validationStatus: r.status, validationReason: r.reason, updatedAt: now })
      }
    })
  },

  async updateMany(ids: number[], changes: Partial<Lead>): Promise<void> {
    const now = nowISO()
    await db.transaction('rw', db.leads, async () => {
      for (const id of ids) {
        await db.leads.update(id, { ...changes, updatedAt: now })
      }
    })
  },

  async patchMissingFields(id: number, updates: Partial<Lead>): Promise<void> {
    await db.leads.update(id, { ...updates, updatedAt: nowISO() })
  },

  async delete(id: number): Promise<void> {
    await db.leads.delete(id)
  },

  async deleteBySession(sessionId: number): Promise<void> {
    await db.leads.where('sessionId').equals(sessionId).delete()
  },

  async count(): Promise<number> {
    return db.leads.count()
  },

  async countBySession(sessionId: number): Promise<number> {
    return db.leads.where('sessionId').equals(sessionId).count()
  },
}

