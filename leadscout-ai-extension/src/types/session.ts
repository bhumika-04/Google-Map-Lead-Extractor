// A Session — one per Search Console run (scrape) OR CSV/Excel import batch.
// Mirrors the MSSQL `sessions` table. Groups all of a run's leads (scraped or
// imported) and carries the ICP prompt used to validate/research them.

export type SessionSource = 'scrape' | 'import'
export type SessionStatus = 'active' | 'running' | 'completed' | 'stopped'

export interface SessionRecord {
  id?: number
  mssqlId?: number          // sessions.id in MSSQL — set after first sync
  name: string
  source: SessionSource
  country?: string
  keywords: string[]
  cities: string[]
  businessProfile?: string
  status: SessionStatus
  totalLeads: number
  createdAt: string
  completedAt?: string
}
