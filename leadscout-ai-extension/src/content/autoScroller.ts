import { extractResultPanel } from './mapsExtractor'

export type ScrollCallback = (panelScrolled: boolean) => void

export class AutoScroller {
  private running = false
  private attempts = 0
  private noNewCount = 0
  private lastCardCount = 0
  private countAtLastTick = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly scrollDelay: number,
    private readonly maxAttempts: number,
    private readonly noNewLeadThreshold: number,
    private readonly onScroll: ScrollCallback,
    private readonly onStop: (reason: string) => void
  ) {}

  start() {
    this.running = true
    this.attempts = 0
    this.noNewCount = 0
    this.scheduleNext()
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext() {
    this.timer = setTimeout(() => this.tick(), this.scrollDelay)
  }

  private tick() {
    if (!this.running) return

    this.attempts++
    if (this.attempts > this.maxAttempts) {
      this.running = false
      this.onStop('scroll_limit')
      return
    }

    const panel = extractResultPanel()
    if (!panel) {
      this.scheduleNext()
      return
    }

    // Use cumulative unique leads (set by updateLastCount) not raw DOM count.
    // Google Maps lazy-loads results so DOM element count can stay flat even
    // when new results are still loading — raw DOM counting causes premature stops.
    if (this.lastCardCount <= this.countAtLastTick) {
      this.noNewCount++
    } else {
      this.noNewCount = 0
    }
    this.countAtLastTick = this.lastCardCount

    if (this.noNewCount >= this.noNewLeadThreshold) {
      this.running = false
      this.onStop('no_new_leads')
      return
    }

    // Check if the panel has stopped growing after scrolling to the bottom
    // (geometric check — works regardless of Google Maps DOM class changes).
    // This fires constantly during normal lazy-loading — scrolling near the
    // bottom of the CURRENTLY rendered content happens on almost every scroll,
    // well before Maps has fetched the next batch. The previous threshold of
    // 3 (just 6-9s of patience) was the dominant cause of ending searches
    // early with far fewer leads than actually existed. Still faster than the
    // main no-new-leads check below (being geometrically at the bottom is a
    // stronger true-completion signal), but with real patience for a lazy-load
    // batch to arrive.
    const AT_BOTTOM_PATIENCE = Math.min(10, this.noNewLeadThreshold)
    const atBottom = panel.scrollHeight > 0 &&
      (panel.scrollTop + panel.clientHeight) >= (panel.scrollHeight - 50)
    if (atBottom && this.noNewCount >= AT_BOTTOM_PATIENCE) {
      this.running = false
      this.onStop('end_of_list')
      return
    }

    // Smooth scroll the panel
    panel.scrollBy({ top: 600, behavior: 'smooth' })
    this.onScroll(true)

    if (this.running) this.scheduleNext()
  }

  updateLastCount(count: number) {
    this.lastCardCount = count
  }
}
