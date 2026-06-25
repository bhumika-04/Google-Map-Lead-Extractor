import type { Lead } from '@/types/lead'

function escapeCsvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const CSV_HEADERS = [
  'Company Name',
  'Category',
  'Rating',
  'Review Count',
  'Address',
  'Phone',
  'Website',
  'Google Maps URL',
  'City',
  'Keyword',
  'Search Query',
  'Status',
  'Captured At',
  'Source',
]

function leadToCsvRow(lead: Lead): string {
  return [
    lead.companyName,
    lead.category,
    lead.rating,
    lead.reviewCount,
    lead.address,
    lead.phone,
    lead.website,
    lead.googleMapsUrl,
    lead.city,
    lead.keyword,
    lead.searchQuery,
    lead.status,
    lead.capturedAt,
    lead.source,
  ]
    .map(escapeCsvField)
    .join(',')
}

export function exportToCSV(leads: Lead[], filename = 'leads.csv'): void {
  const rows = [CSV_HEADERS.join(','), ...leads.map(leadToCsvRow)]
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  downloadBlob(blob, filename)
}

export function exportToJSON(leads: Lead[], filename = 'leads.json'): void {
  const clean = leads.map(({ id: _id, ...rest }) => rest)
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' })
  downloadBlob(blob, filename)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
