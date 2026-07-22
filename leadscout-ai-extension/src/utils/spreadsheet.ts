// Unified spreadsheet parser for lead imports — accepts .csv, .xlsx, and .xls
// and returns { headers, rows } in the same shape as the existing CSV parser,
// so the row → Lead mapping (mapRow / FIELD_MAP) is shared across all formats.

import { parseCSV } from '@/utils/csvImport'

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, string>[]
}

// File types accepted by the import file pickers / drop zones.
export const IMPORT_ACCEPT =
  '.csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function isSpreadsheetFile(name: string): boolean {
  return /\.(csv|xlsx|xls|xlsm)$/i.test(name)
}

// Parses the first worksheet of an Excel file (or a CSV) into headers + rows.
// The first non-empty row is treated as the header row; blank rows are dropped.
export async function parseSpreadsheet(file: File): Promise<ParsedSheet> {
  const name = file.name.toLowerCase()

  if (/\.(xlsx|xls|xlsm)$/.test(name)) {
    // Lazy-loaded so SheetJS (~400 KB) is only fetched when a user actually
    // imports an Excel file — keeps the main dashboard bundle small.
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const firstSheet = wb.SheetNames[0]
    if (!firstSheet) return { headers: [], rows: [] }

    // header:1 → array-of-arrays (matrix); defval keeps empty cells aligned.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[firstSheet], {
      header: 1,
      blankrows: false,
      defval: '',
    })
    if (matrix.length < 2) return { headers: [], rows: [] }

    const headers = (matrix[0] as unknown[]).map((h) => String(h ?? '').trim())
    const rows: Record<string, string>[] = []
    for (let i = 1; i < matrix.length; i++) {
      const r = matrix[i] as unknown[]
      if (!r || !r.some((c) => String(c ?? '').trim())) continue
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => { obj[h] = String(r[idx] ?? '').trim() })
      rows.push(obj)
    }
    return { headers, rows }
  }

  // CSV (or unknown extension — best-effort as text)
  const text = await file.text()
  return parseCSV(text)
}
