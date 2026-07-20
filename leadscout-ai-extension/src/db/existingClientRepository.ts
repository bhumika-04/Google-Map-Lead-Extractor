import { db } from './db'
import type { ExistingClient } from '@/types/existingClient'
import { normalizeLeadName } from '@/utils/dedupe'
import { normalizePhone } from '@/utils/normalize'

export const existingClientRepository = {
  async create(client: Omit<ExistingClient, 'id'>): Promise<number> {
    return db.existingClients.add(client)
  },

  async bulkCreate(clients: Omit<ExistingClient, 'id'>[]): Promise<void> {
    await db.existingClients.bulkAdd(clients)
  },

  async getAll(): Promise<ExistingClient[]> {
    return db.existingClients.orderBy('uploadedAt').reverse().toArray()
  },

  async delete(id: number): Promise<void> {
    await db.existingClients.delete(id)
  },

  async clear(): Promise<void> {
    await db.existingClients.clear()
  },

  async count(): Promise<number> {
    return db.existingClients.count()
  },

  // Replaces all local rows with the given set — used to mirror MSSQL (source of truth).
  async replaceAll(clients: Omit<ExistingClient, 'id'>[]): Promise<void> {
    await db.transaction('rw', db.existingClients, async () => {
      await db.existingClients.clear()
      if (clients.length) await db.existingClients.bulkAdd(clients)
    })
  },

  // Matches an outreach target against the existing-clients list — phone first
  // (most reliable for WhatsApp), falling back to normalized company name + city.
  async findMatch(phone?: string, companyName?: string, city?: string): Promise<ExistingClient | undefined> {
    if (phone) {
      const np = normalizePhone(phone)
      if (np) {
        const byPhone = await db.existingClients.where('normalizedPhone').equals(np).first()
        if (byPhone) return byPhone
      }
    }
    if (companyName) {
      const nn = normalizeLeadName(companyName)
      const candidates = await db.existingClients.where('normalizedName').equals(nn).toArray()
      if (candidates.length === 0) return undefined
      if (!city) return candidates[0]
      const nc = city.toLowerCase().trim()
      return candidates.find((c) => (c.city ?? '').toLowerCase().trim() === nc) ?? candidates[0]
    }
    return undefined
  },
}
