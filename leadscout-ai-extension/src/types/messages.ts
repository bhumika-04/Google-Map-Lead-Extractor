import type { Lead } from './lead'
import type { AppSettings } from './settings'

// ─── Message type constants ───────────────────────────────────────────────────

export const MSG = {
  // Dashboard → Background
  SEARCH_START:       'SEARCH_START',
  SEARCH_QUEUE_START: 'SEARCH_QUEUE_START',   // multi-term run — queue owned by the service worker
  CAPTURE_STOP:       'CAPTURE_STOP',
  GET_STATUS:         'GET_STATUS',
  OPEN_DASHBOARD:     'OPEN_DASHBOARD',

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
  PIPELINE_RUN:      'PIPELINE_RUN',   // (re)run enrichment + validation + research
  PIPELINE_RUN_STEP: 'PIPELINE_RUN_STEP', // re-run ONE step (enrichment/validation/research) for a session
  PIPELINE_STOP:     'PIPELINE_STOP',  // stop the running pipeline
  VERIFY_FROM_GOOGLE:'VERIFY_FROM_GOOGLE', // fetch exact turnover/team size from Google AI mode
  QUALIFY_IMPORTED:  'QUALIFY_IMPORTED',   // validate/score imported leads against the ICP
  BACKGROUND_DISCOVER: 'BACKGROUND_DISCOVER',
  DISCOVER_STATUS:   'DISCOVER_STATUS',

  // Background → Dashboard (broadcast)
  PROGRESS_UPDATE:   'PROGRESS_UPDATE',
  SESSION_UPDATED:   'SESSION_UPDATED',

  // Dashboard → Background (DB sync)
  SYNC_FROM_DB:      'SYNC_FROM_DB',

  // Batch campaigns
  BATCH_CAMPAIGN_START:  'BATCH_CAMPAIGN_START',
  BATCH_CAMPAIGN_STOP:   'BATCH_CAMPAIGN_STOP',
  BATCH_CAMPAIGN_STATUS: 'BATCH_CAMPAIGN_STATUS',

  // Follow-up scheduler
  CHECK_FOLLOWUPS: 'CHECK_FOLLOWUPS',

  // LinkedIn automated scraper
  LI_SCRAPER_START:  'LI_SCRAPER_START',   // dashboard → SW: start job for a lead
  LI_SCRAPER_READY:  'LI_SCRAPER_READY',   // content   → SW: page loaded, awaiting instructions
  LI_SCRAPER_DATA:   'LI_SCRAPER_DATA',    // content   → SW: scraped data for one step
  LI_SCRAPER_CANCEL: 'LI_SCRAPER_CANCEL',  // dashboard → SW: abort job
  LI_SCRAPER_STATUS: 'LI_SCRAPER_STATUS',  // dashboard → SW: poll current job state
} as const

export type MessageType = typeof MSG[keyof typeof MSG]

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface SearchStartPayload {
  sessionId: number
  city: string
  keyword: string
  country: string              // ISO code e.g. 'IN', 'AE', 'SA'
  maxResults: number
  mapsUrl: string
  settings: Pick<AppSettings, 'autoScrollDelay' | 'maxScrollAttempts' | 'noNewLeadStopThreshold'>
  projectId?: number           // Search Session — stamped on every captured lead
}

// Multi-term Search Console run. The full keyword×city list is handed to the
// service worker in one message — the SW persists it (chrome.storage.local) and
// drives the whole run itself, so closing/refreshing the dashboard tab can no
// longer kill a long sequential run partway through.
export interface SearchQueueStartPayload {
  terms: Array<{ keyword: string; city: string }>
  country: string
  settings: Pick<AppSettings, 'autoScrollDelay' | 'maxScrollAttempts' | 'noNewLeadStopThreshold'>
  projectId?: number   // Search Session created by the dashboard before submitting the run
}

// Queue progress attached to PROGRESS_UPDATE broadcasts (and GET_STATUS
// responses) so the dashboard can display "Term 26 of 490" after a reload.
export interface SearchQueueProgress {
  current: number      // 1-based index of the term now running
  total: number
  keyword: string
  city: string
  totalLeads: number   // cumulative across finished terms
  done?: boolean       // set on the final broadcast when the whole run completes
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
  // Optional pipeline phase — set during the post-capture enrichment/validation steps.
  // Separate from capture `status` so badge logic and completed-toast logic are not affected.
  pipelinePhase?: string
  // Present when this progress belongs to a service-worker-driven multi-term run.
  queue?: SearchQueueProgress
}

// ─── Generic message envelope ─────────────────────────────────────────────────

export interface ExtMessage<T = unknown> {
  type: MessageType
  payload?: T
}
