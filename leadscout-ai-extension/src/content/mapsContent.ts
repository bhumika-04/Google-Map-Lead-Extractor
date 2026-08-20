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
import { extractVisibleCards, buildLead, extractResultPanel, extractDetailPanelData, extractSingleBusinessFromPlacePage, getDetailHeading, type RawBusinessCard } from './mapsExtractor'
import { AutoScroller } from './autoScroller'

// ─── State ────────────────────────────────────────────────────────────────────

let captureActive = false
let sessionId: number | null = null
let maxResults = 100
let capturedUrls = new Set<string>()
let totalSent = 0
let scroller: AutoScroller | null = null
// Re-entrancy guard — captureVisible() now clicks into cards to read their
// detail panel, which takes seconds. AutoScroller keeps ticking on its own
// timer regardless, so a second tick can fire before the first sweep (still
// mid click-through) has returned; without this guard the two would fight
// over navigating the same Maps panel.
let visiting = false

let captureSettings = {
  autoScrollDelay: 2000,
  maxScrollAttempts: 60,
  noNewLeadStopThreshold: 12,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Compares normalized name prefixes to handle truncation in either direction.
function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const nA = normalize(a)
  const nB = normalize(b)
  const minLen = Math.min(nA.length, nB.length, 20)
  if (minLen === 0) return false
  return nA.slice(0, minLen) === nB.slice(0, minLen)
}

// Returns true if the open detail panel is likely showing this company.
function isDetailPanelMatch(cardName: string, panel: ReturnType<typeof extractDetailPanelData>): boolean {
  if (!panel || (!panel.phone && !panel.website)) return false
  const heading = getDetailHeading()
  if (!heading) return true // no heading — assume match, merge anyway
  return namesMatch(cardName, heading)
}

// Re-finds a card's clickable link in the CURRENT list DOM. List cards get
// rebuilt whenever Maps swaps the panel between list and detail view, so a
// reference captured before a previous click-through visit is stale by the
// time we're ready for the next card.
function findCardLink(googleMapsUrl: string | undefined, companyName: string): HTMLAnchorElement | null {
  const panel = extractResultPanel()
  if (!panel) return null
  const links = Array.from(panel.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]')) as HTMLAnchorElement[]
  if (googleMapsUrl) {
    const exact = links.find((a) => a.href.split('?')[0] === googleMapsUrl)
    if (exact) return exact
  }
  return links.find((a) => namesMatch(a.getAttribute('aria-label') ?? '', companyName)) ?? null
}

// Click into a card's detail panel to read phone/website/full address — none
// of these reliably render on the collapsed list card itself, only on the
// detail panel Maps shows after opening a listing. Mutates `raw` in place,
// then returns to the results list before resolving.
async function visitCardDetails(raw: RawBusinessCard): Promise<void> {
  const link = findCardLink(raw.googleMapsUrl, raw.companyName)
  if (!link) return
  link.click()

  const matchStart = Date.now()
  let matched = false
  while (Date.now() - matchStart < 3500) {
    if (!captureActive) break
    if (namesMatch(raw.companyName, getDetailHeading())) { matched = true; break }
    await sleep(200)
  }

  if (matched) {
    await sleep(300) // let phone/website finish rendering after the heading appears
    const panel = extractDetailPanelData()
    // The detail panel's data is more complete than the list card's (which
    // truncates addresses and rarely shows phone/website at all) — prefer it
    // outright rather than only filling gaps.
    if (panel.phone) raw.phone = panel.phone
    if (panel.website) raw.website = panel.website
    if (panel.address) raw.address = panel.address
  }

  const backBtn = document.querySelector('button[aria-label="Back" i]') as HTMLElement | null
  if (backBtn) backBtn.click()
  else history.back()

  const backStart = Date.now()
  while (Date.now() - backStart < 2500) {
    if (extractResultPanel()) break
    await sleep(150)
  }
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

async function captureVisible() {
  if (!captureActive || sessionId === null) return
  if (visiting) return   // a previous sweep is still click-visiting cards
  visiting = true

  try {
    // Snapshot detail panel once up front — fills gaps when a card already
    // happens to be selected before we start clicking into anything ourselves.
    const detailPanel = extractDetailPanelData()

    const cards = extractVisibleCards()
    const newRaws: RawBusinessCard[] = []
    for (const raw of cards) {
      // Local content-script dedup by URL or name (DB-level dedup is in background)
      const key = raw.googleMapsUrl || raw.companyName
      if (capturedUrls.has(key)) continue
      capturedUrls.add(key)

      if (detailPanel && isDetailPanelMatch(raw.companyName, detailPanel)) {
        if (!raw.phone && detailPanel.phone) raw.phone = detailPanel.phone
        if (!raw.website && detailPanel.website) raw.website = detailPanel.website
        if (!raw.address && detailPanel.address) raw.address = detailPanel.address
      }
      newRaws.push(raw)
    }

    for (const raw of newRaws) {
      if (!captureActive) break
      if (totalSent >= maxResults) { stopCapture('max_reached'); break }

      // List cards essentially never carry phone/website — click into the
      // detail panel to fill them in (and get the untruncated address).
      if (!raw.phone || !raw.website) {
        await visitCardDetails(raw)
      }

      const lead = buildLead(raw, sessionId, '', '', '')
      totalSent++
      chrome.runtime.sendMessage({
        type: MSG.LEAD_FOUND,
        payload: { lead, sessionId },
      }).catch(() => {})

      sendProgress('running', `${totalSent} leads captured`)
      scroller?.updateLastCount(totalSent)
    }

    // Heartbeat even when this sweep found nothing new (e.g. still loading
    // the next lazy-load batch) — keeps the dashboard progress UI live.
    if (newRaws.length === 0) {
      sendProgress('running', `${totalSent} leads captured`)
      scroller?.updateLastCount(totalSent)
    }
  } finally {
    visiting = false
  }
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
  waitForPanel().then((foundPanel) => {
    if (!captureActive) return

    // Google Maps sometimes redirects a search straight to a single business's
    // /maps/place/ page instead of a results list (e.g. the search text closely
    // matches one business's exact listed name). No list means captureVisible()
    // would find zero cards and the session would silently end with nothing —
    // capture that one exact match directly instead of wasting the attempt.
    //
    // IMPORTANT: only take this path when we can POSITIVELY confirm we're on a
    // place page via the URL. A missing panel after the wait window can simply
    // mean a normal results list is loading slowly (common across a long
    // sequential multi-keyword run) — treating every timeout as "single
    // business page" was wrongly ending normal searches with 0 leads captured.
    const isPlacePage = /\/maps\/place\//.test(location.pathname)
    if (!foundPanel && isPlacePage) {
      const single = extractSingleBusinessFromPlacePage()
      if (single) {
        const key = single.googleMapsUrl || single.companyName
        if (!capturedUrls.has(key)) {
          capturedUrls.add(key)
          const lead = buildLead(single, sessionId!, '', '', '')
          totalSent++
          chrome.runtime.sendMessage({ type: MSG.LEAD_FOUND, payload: { lead, sessionId } }).catch(() => {})
        }
      }
      stopCapture(single ? 'end_of_list' : 'no_new_leads')
      return
    }

    // Normal results-list search (including the case where the panel just
    // hadn't rendered yet within the wait window) — proceed as before and let
    // the scroller keep retrying as Maps finishes rendering.
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

function waitForPanel(maxWait = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (extractResultPanel()) {
        resolve(true)
        return
      }
      if (Date.now() - start > maxWait) {
        resolve(false) // no results list found — likely a single-business place page
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
