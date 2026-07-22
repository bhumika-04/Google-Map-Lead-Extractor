import { normalizeLeadName } from '@/utils/dedupe'
import { nowISO } from '@/utils/date'
import type { Lead } from '@/types/lead'

// Maps common CSV column names → Lead field keys. Shared by the CSV/Excel
// importers (ImportPanel, SelectedCsvImport) and the spreadsheet parser.
export const FIELD_MAP: Record<string, keyof Lead> = {
  company_name: 'companyName', companyname: 'companyName', company: 'companyName', name: 'companyName', business: 'companyName',
  phone: 'phone', telephone: 'phone', mobile: 'phone', contact: 'phone',
  website: 'website', url: 'website', web: 'website',
  city: 'city', town: 'city', location: 'city',
  address: 'address', street: 'address',
  category: 'category', type: 'category', industry: 'category',
  rating: 'rating', stars: 'rating', score: 'rating',
  review_count: 'reviewCount', reviewcount: 'reviewCount', reviews: 'reviewCount', review_count2: 'reviewCount',
  notes: 'notes',
  tags: 'tags',
  keyword: 'keyword',
  google_maps_url: 'googleMapsUrl', googlemapsurl: 'googleMapsUrl', maps_url: 'googleMapsUrl',
}

export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }

  function parseLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim()); current = ''
      } else {
        current += ch
      }
    }
    result.push(current.trim())
    return result
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const vals = parseLine(line)
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h] = vals[i] ?? '' })
      return obj
    })

  return { headers, rows }
}

export function mapRow(row: Record<string, string>, sessionId: number): Omit<Lead, 'id'> | null {
  const mapped: Partial<Lead> = {}

  for (const [csvKey, val] of Object.entries(row)) {
    const normalized = csvKey.toLowerCase().replace(/[\s-]/g, '_')
    const field = FIELD_MAP[normalized] ?? FIELD_MAP[csvKey.toLowerCase().replace(/\s/g, '')]
    if (!field || !val) continue

    if (field === 'rating' || field === 'reviewCount') {
      const n = parseFloat(val)
      if (!isNaN(n)) (mapped as any)[field] = n
    } else if (field === 'tags') {
      mapped.tags = val.split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
    } else {
      (mapped as any)[field] = val
    }
  }

  const companyName = (mapped.companyName ?? '').trim()
  if (!companyName) return null

  const now = nowISO()
  return {
    sessionId,
    companyName,
    normalizedName: normalizeLeadName(companyName),
    category:       mapped.category,
    rating:         mapped.rating,
    reviewCount:    mapped.reviewCount,
    address:        mapped.address,
    phone:          mapped.phone,
    website:        mapped.website,
    googleMapsUrl:  mapped.googleMapsUrl,
    searchQuery:    '',
    city:           (mapped.city ?? '').trim() || 'Imported',
    keyword:        (mapped.keyword ?? '').trim() || 'csv-import',
    source:         'google_maps',
    confidence:     0.8,
    status:         'new',
    notes:          mapped.notes,
    tags:           mapped.tags,
    capturedAt:     now,
    updatedAt:      now,
  }
}
