import type { Lead } from '@/types/lead'
import { normalizeName, normalizePhone, normalizeUrl, normalizeAddress } from './normalize'

export interface DedupeKey {
  byMapsUrl?: string
  byPhone?: string
  byNameAddress?: string
  byNameCity?: string       // name + city — keyword-agnostic, the canonical unique key
}

export function buildDedupeKeys(lead: Omit<Lead, 'id'>): DedupeKey {
  const keys: DedupeKey = {}

  if (lead.googleMapsUrl) {
    keys.byMapsUrl = normalizeUrl(lead.googleMapsUrl)
  }
  if (lead.phone) {
    keys.byPhone = normalizePhone(lead.phone)
  }
  if (lead.normalizedName && lead.address) {
    keys.byNameAddress = `${lead.normalizedName}|${normalizeAddress(lead.address)}`
  }
  if (lead.normalizedName && lead.city) {
    keys.byNameCity = `${lead.normalizedName}|${lead.city.toLowerCase()}`
  }

  return keys
}

export function isDuplicate(
  incoming: Omit<Lead, 'id'>,
  existing: Lead[]
): Lead | null {
  const keys = buildDedupeKeys(incoming)

  for (const lead of existing) {
    const existingKeys = buildDedupeKeys(lead)

    if (keys.byMapsUrl && existingKeys.byMapsUrl && keys.byMapsUrl === existingKeys.byMapsUrl) {
      return lead
    }
    if (keys.byPhone && existingKeys.byPhone && keys.byPhone === existingKeys.byPhone) {
      return lead
    }
    if (keys.byNameAddress && existingKeys.byNameAddress && keys.byNameAddress === existingKeys.byNameAddress) {
      return lead
    }
    if (keys.byNameCity && existingKeys.byNameCity && keys.byNameCity === existingKeys.byNameCity) {
      return lead
    }
  }

  return null
}

export function mergeLeadData(existing: Lead, incoming: Omit<Lead, 'id'>): Partial<Lead> {
  const updates: Partial<Lead> = {}

  if (!existing.phone && incoming.phone) updates.phone = incoming.phone
  if (!existing.website && incoming.website) updates.website = incoming.website
  if (!existing.category && incoming.category) updates.category = incoming.category
  if (!existing.rating && incoming.rating) updates.rating = incoming.rating
  if (!existing.reviewCount && incoming.reviewCount) updates.reviewCount = incoming.reviewCount
  if (!existing.address && incoming.address) updates.address = incoming.address
  if (!existing.googleMapsUrl && incoming.googleMapsUrl) updates.googleMapsUrl = incoming.googleMapsUrl

  return updates
}

export function normalizeLeadName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')  // preserve non-Latin scripts
    .replace(/\s+/g, ' ')
    .trim()
}
