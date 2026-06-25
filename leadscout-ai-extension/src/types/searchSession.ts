export type SessionStatus =
  | 'idle'
  | 'opening_maps'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error'

export interface SearchSession {
  id?: number
  city: string
  keyword: string
  generatedQuery: string
  mapsUrl: string
  status: SessionStatus
  maxResults: number
  totalCaptured: number
  duplicatesSkipped: number
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface SearchInput {
  city: string
  keyword: string
  maxResults: number
}
