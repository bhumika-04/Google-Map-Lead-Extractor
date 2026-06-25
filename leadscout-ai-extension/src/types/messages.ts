import type { Lead } from './lead'
import type { AppSettings } from './settings'

// ─── Message type constants ───────────────────────────────────────────────────

export const MSG = {
  // Dashboard → Background
  SEARCH_START:     'SEARCH_START',
  CAPTURE_STOP:     'CAPTURE_STOP',
  GET_STATUS:       'GET_STATUS',
  OPEN_DASHBOARD:   'OPEN_DASHBOARD',

  // Background → Content
  MAPS_START_CAPTURE: 'MAPS_START_CAPTURE',
  MAPS_STOP_CAPTURE:  'MAPS_STOP_CAPTURE',

  // Content → Background
  CONTENT_READY:     'CONTENT_READY',
  LEAD_FOUND:        'LEAD_FOUND',
  CAPTURE_PROGRESS:  'CAPTURE_PROGRESS',
  CAPTURE_FINISHED:  'CAPTURE_FINISHED',
  CAPTURE_ERROR:     'CAPTURE_ERROR',

  // Dashboard → Background (manual triggers)
  TRIGGER_RESEARCH:  'TRIGGER_RESEARCH',
  BACKGROUND_DISCOVER: 'BACKGROUND_DISCOVER',
  DISCOVER_STATUS:   'DISCOVER_STATUS',

  // Background → Dashboard (broadcast)
  PROGRESS_UPDATE:   'PROGRESS_UPDATE',
  SESSION_UPDATED:   'SESSION_UPDATED',

  // Dashboard → Background (DB sync)
  SYNC_FROM_DB:      'SYNC_FROM_DB',
} as const

export type MessageType = typeof MSG[keyof typeof MSG]

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface SearchStartPayload {
  sessionId: number
  city: string
  keyword: string
  maxResults: number
  mapsUrl: string
  settings: Pick<AppSettings, 'autoScrollDelay' | 'maxScrollAttempts' | 'noNewLeadStopThreshold'>
}

export interface MapsStartCapturePayload {
  sessionId: number
  maxResults: number
  settings: Pick<AppSettings, 'autoScrollDelay' | 'maxScrollAttempts' | 'noNewLeadStopThreshold'>
}

export interface LeadFoundPayload {
  lead: Omit<Lead, 'id'>
  sessionId: number
}

export interface CaptureProgressPayload {
  sessionId: number
  totalCaptured: number
  duplicatesSkipped: number
  status: 'running' | 'completed' | 'stopped' | 'error'
  message?: string
}

export interface CaptureFinishedPayload {
  sessionId: number
  totalCaptured: number
  reason: 'max_reached' | 'no_new_leads' | 'end_of_list' | 'scroll_limit' | 'stopped' | 'error'
}

export interface ProgressUpdatePayload {
  sessionId: number
  totalCaptured: number
  duplicatesSkipped: number
  status: string
  message?: string
}

// ─── Generic message envelope ─────────────────────────────────────────────────

export interface ExtMessage<T = unknown> {
  type: MessageType
  payload?: T
}
