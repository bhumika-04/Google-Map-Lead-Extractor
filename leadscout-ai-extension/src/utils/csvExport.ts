// Shared CSV export schema used across every dashboard page so exported files
// import cleanly into bulk WhatsApp/CRM tools (Interakt etc).
const EXPORT_HEADERS = [
  'Name',
  'Country Code',
  'Phone Number',
  'Email',
  'Tags',
  'Creation Date',
  'Company Name',
  'City',
  'Category',
  'Address',
  'Website',
  'Rating',
  'ICP Score',
  'ICP Status',
  'Turnover',
  'Team Size',
  'Core Member',
  'Working Domain',
  'Company Type',
  'CIN',
  'UAN',
] as const

export interface ExportRowInput {
  name?: string
  phone?: string
  email?: string
  tags?: string[] | string
  creationDate?: string
  companyName?: string
  city?: string
  category?: string
  address?: string
  website?: string
  rating?: number
  icpScore?: number
  icpStatus?: string
  turnover?: string
  teamSize?: string
  coreMember?: string
  workingDomain?: string
  companyType?: string
  cin?: string
  uan?: string
  defaultCountryCode?: string
}

function escapeCsvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// Splits "+91 98765 43210" → { countryCode: '+91', number: '9876543210' }.
// Falls back to defaultCountryCode (Settings → Interakt) when the phone has no leading "+".
function splitPhone(phone: string | undefined, defaultCountryCode: string): { countryCode: string; number: string } {
  if (!phone) return { countryCode: '', number: '' }
  const trimmed = phone.trim()
  const match = trimmed.match(/^\+(\d{1,3})[\s-]?(.*)$/)
  if (match) return { countryCode: `+${match[1]}`, number: match[2].replace(/[\s\-()]/g, '') }
  return { countryCode: defaultCountryCode, number: trimmed.replace(/[\s\-()]/g, '') }
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function buildExportRow(input: ExportRowInput): string[] {
  const { countryCode, number } = splitPhone(input.phone, input.defaultCountryCode ?? '+91')
  const tags = Array.isArray(input.tags) ? input.tags.filter(Boolean).join(';') : (input.tags ?? '')
  return [
    input.name ?? input.companyName ?? '',
    countryCode,
    number,
    input.email ?? '',
    tags,
    formatDate(input.creationDate),
    input.companyName ?? '',
    input.city ?? '',
    input.category ?? '',
    input.address ?? '',
    input.website ?? '',
    input.rating != null ? String(input.rating) : '',
    input.icpScore != null ? String(input.icpScore) : '',
    input.icpStatus ?? '',
    input.turnover ?? '',
    input.teamSize ?? '',
    input.coreMember ?? '',
    input.workingDomain ?? '',
    input.companyType ?? '',
    input.cin ?? '',
    input.uan ?? '',
  ]
}

export function exportRowsToCSV(rows: ExportRowInput[], filename: string): void {
  const lines = [
    EXPORT_HEADERS.join(','),
    ...rows.map((r) => buildExportRow(r).map(escapeCsvField).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function exportFileName(prefix: string): string {
  return `${prefix}-export-${Date.now()}.csv`
}

// Generic CSV writer for exports that don't need to match the fixed
// Interakt-compatible schema above (e.g. a full-data research export).
export function exportFullCSV(headers: string[], rows: (string | number | undefined | null)[][], filename: string): void {
  const lines = [
    headers.map(escapeCsvField).join(','),
    ...rows.map((row) => row.map(escapeCsvField).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
