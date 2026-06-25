import type { MapsStartCapturePayload, CaptureFinishedPayload } from '@/types/messages'

// Inlined to keep content script self-contained (no shared Rollup chunks)
const MSG = {
  MAPS_START_CAPTURE: 'MAPS_START_CAPTURE',
  MAPS_STOP_CAPTURE:  'MAPS_STOP_CAPTURE',
  LEAD_FOUND:         'LEAD_FOUND',
  CAPTURE_PROGRESS:   'CAPTURE_PROGRESS',
  CAPTURE_FINISHED:   'CAPTURE_FINISHED',
  GET_STATUS:         'GET_STATUS',
  CONTENT_READY:      'CONTENT_READY',
} as const
import { extractVisibleCards, buildLead, extractResultPanel, extractDetailPanelData } from './mapsExtractor'
import { AutoScroller } from './autoScroller'

// ─── State ────────────────────────────────────────────────────────────────────

let captureActive = false
let sessionId: number | null = null
let maxResults = 100
let capturedUrls = new Set<string>()
let totalSent = 0
let scroller: AutoScroller | null = null

let captureSettings = {
  autoScrollDelay: 2000,
  maxScrollAttempts: 60,
  noNewLeadStopThreshold: 12,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Returns true if the open detail panel is likely showing this company.
// We compare normalized name prefixes to handle truncation in either direction.
function isDetailPanelMatch(cardName: string, panel: ReturnType<typeof extractDetailPanelData>): boolean {
  if (!panel || (!panel.phone && !panel.website)) return false
  // Get the panel title from the page heading
  const heading =
    document.querySelector('h1.DUwDvf')?.textContent?.trim() ??
    document.querySelector('[role="main"] h1')?.textContent?.trim() ??
    document.querySelector('div[aria-label][role="main"]')?.getAttribute('aria-label')?.trim() ?? ''
  if (!heading) return true // no heading — assume match, merge anyway
  const nCard = normalize(cardName)
  const nPanel = normalize(heading)
  const minLen = Math.min(nCard.length, nPanel.length, 20)
  return nCard.slice(0, minLen) === nPanel.slice(0, minLen)
}

// ─── Core capture logic ───────────────────────────────────────────────────────

function sendProgress(status: 'running' | 'completed' | 'stopped' | 'error', msg?: string) {
  chrome.runtime.sendMessage({
    type: MSG.CAPTURE_PROGRESS,
    payload: {
      sessionId,
      totalCaptured: totalSent,
      duplicatesSkipped: 0,
      status,
      message: msg,
    },
  }).catch(() => {})
}

function captureVisible() {
  if (!captureActive || sessionId === null) return

  // Snapshot detail panel once per tick — fills gaps when a card is selected
  const detailPanel = extractDetailPanelData()

  const cards = extractVisibleCards()
  for (const raw of cards) {
    if (totalSent >= maxResults) {
      stopCapture('max_reached')
      return
    }

    // Local content-script dedup by URL or name (DB-level dedup is in background)
    const key = raw.googleMapsUrl || raw.companyName
    if (capturedUrls.has(key)) continue
    capturedUrls.add(key)

    // Merge detail panel data for missing fields (panel matches the selected card)
    if (detailPanel && isDetailPanelMatch(raw.companyName, detailPanel)) {
      if (!raw.phone && detailPanel.phone) raw.phone = detailPanel.phone
      if (!raw.website && detailPanel.website) raw.website = detailPanel.website
      if (!raw.address && detailPanel.address) raw.address = detailPanel.address
    }

    const lead = buildLead(raw, sessionId, '', '', '')
    totalSent++

    chrome.runtime.sendMessage({
      type: MSG.LEAD_FOUND,
      payload: { lead, sessionId },
    }).catch(() => {})
  }

  sendProgress('running', `${totalSent} leads captured`)
  // Pass cumulative unique leads sent (totalSent) not cards.length —
  // Maps virtual list keeps DOM card count flat; totalSent grows only when new results appear.
  scroller?.updateLastCount(totalSent)
}

function stopCapture(reason: CaptureFinishedPayload['reason']) {
  captureActive = false
  scroller?.stop()
  scroller = null

  chrome.runtime.sendMessage({
    type: MSG.CAPTURE_FINISHED,
    payload: { sessionId, totalCaptured: totalSent, reason } as CaptureFinishedPayload,
  }).catch(() => {})
}

function startCapture(payload: MapsStartCapturePayload) {
  if (captureActive) return

  sessionId = payload.sessionId
  maxResults = payload.maxResults
  captureSettings = payload.settings
  capturedUrls = new Set()
  totalSent = 0
  captureActive = true

  // Wait for Maps results panel to appear before starting scroll
  waitForPanel().then(() => {
    if (!captureActive) return

    captureVisible()

    scroller = new AutoScroller(
      captureSettings.autoScrollDelay,
      captureSettings.maxScrollAttempts,
      captureSettings.noNewLeadStopThreshold,
      () => captureVisible(),
      (reason) => stopCapture(reason as CaptureFinishedPayload['reason'])
    )
    scroller.start()
    sendProgress('running', 'Capture started')
  })
}

function waitForPanel(maxWait = 10000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (extractResultPanel()) {
        resolve()
        return
      }
      if (Date.now() - start > maxWait) {
        resolve() // proceed anyway
        return
      }
      setTimeout(check, 500)
    }
    check()
  })
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === MSG.MAPS_START_CAPTURE) {
    startCapture(msg.payload as MapsStartCapturePayload)
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === MSG.MAPS_STOP_CAPTURE) {
    stopCapture('stopped')
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === MSG.GET_STATUS) {
    sendResponse({ captureActive, sessionId, totalSent })
    return true
  }
})

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: MSG.CONTENT_READY }).catch(() => {})
