// ─── LinkedIn DOM Probe v3 ────────────────────────────────────────────────────
// 3-step diagnostic workflow (read-only, no DB writes):
//
//   Step 1 → /company/NAME/posts/          — Company posts last 30 days
//   Step 2 → /company/NAME/people/         — Team members, highlights CORE members
//   Step 3 → /in/USERNAME/recent-activity/ — Core member's personal posts last 30 days
//
// All extraction uses stable selectors: data-urn, aria-hidden spans, <time>, href walks.
// Click "🔍 Probe DOM" then check DevTools console (F12).
// ─────────────────────────────────────────────────────────────────────────────

// ── Core member title keywords ────────────────────────────────────────────────
// A person is "core" if their title contains any of these (case-insensitive)

const CORE_TITLE_KEYWORDS = [
  'founder', 'co-founder', 'cofounder',
  'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cso', 'cpo', 'chro',
  'managing director', 'md', 'executive director',
  'director', 'president', 'vice president', 'vp',
  'head of', 'head -', 'head,',
  'partner', 'principal', 'owner', 'proprietor',
  'general manager', 'gm',
  'chief', 'board member', 'trustee',
]

function isCore(title: string): boolean {
  const t = title.toLowerCase()
  return CORE_TITLE_KEYWORDS.some(kw => t.includes(kw))
}

// ── Page type detection ───────────────────────────────────────────────────────

type PageType =
  | 'company-posts'    // /company/*/posts/ or /company/*/  (overview shows posts)
  | 'company-people'   // /company/*/people/
  | 'search-people'    // /search/results/people/  (people search results)
  | 'profile-posts'    // /in/*/recent-activity/shares/ or /in/*/recent-activity/
  | 'profile'          // /in/*/  (main profile page)
  | 'other'

function detectPage(): { type: PageType; hint: string } {
  const p = location.pathname
  if (/^\/company\/[^/]+\/people/.test(p))
    return { type: 'company-people', hint: 'Step 2 — Team members (company)' }
  if (/^\/company\/[^/]+\/(posts|updates|recent-activity)/.test(p))
    return { type: 'company-posts', hint: 'Step 1 — Company posts' }
  if (/^\/company\/[^/]+\/?$/.test(p) || /^\/company\/[^/]+\/about/.test(p))
    return { type: 'company-posts', hint: 'Step 1 — Company overview (scroll to posts)' }
  if (/^\/in\/[^/]+\/recent-activity/.test(p))
    return { type: 'profile-posts', hint: 'Step 3 — Member personal posts' }
  if (/^\/in\/[^/]+/.test(p))
    return { type: 'profile', hint: 'Step 3 — Member profile (go to Activity tab for posts)' }
  if (/^\/search\/results\/(people|all)/.test(p))
    return { type: 'search-people', hint: 'People search results' }
  return { type: 'other', hint: '' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}
function attr(el: Element | null | undefined, name: string): string {
  return el?.getAttribute(name)?.trim() ?? ''
}
function cleanUrl(href: string): string {
  if (!href) return ''
  const clean = href.split('?')[0].replace(/\/$/, '')
  return clean.startsWith('http') ? clean : `https://www.linkedin.com${clean}`
}

function parseDaysAgo(raw: string): number | null {
  const s = raw.toLowerCase()
  const n = parseInt(s)
  if (isNaN(n)) {
    if (s.includes('just') || s.includes('now')) return 0
    if (s.includes('yesterday'))                  return 1
    return null
  }
  if (s.includes('min') || s.includes('hour')) return 0
  if (s.includes('day'))   return n
  if (s.includes('week'))  return n * 7
  if (s.includes('month')) return n * 30
  if (s.includes('year'))  return n * 365
  return null
}

// Walk up from an element to find the card root (li / article / data-urn container)
function cardRoot(el: Element, max = 10): Element {
  let node: Element | null = el
  for (let i = 0; i < max; i++) {
    if (!node?.parentElement) break
    node = node.parentElement
    const tag = node.tagName.toLowerCase()
    if (
      tag === 'li' || tag === 'article' ||
      node.getAttribute('role') === 'listitem' ||
      node.getAttribute('data-urn') ||
      node.getAttribute('data-id') ||
      node.getAttribute('data-entity-urn')
    ) return node
  }
  return el.parentElement ?? el
}

// ── Raw DOM inventory (always run) ───────────────────────────────────────────

function domInventory() {
  console.group('DOM inventory')
  const checks: [string, string][] = [
    ['<time> elements',         'time'],
    ['[data-urn] elements',     '[data-urn]'],
    ['[data-id] elements',      '[data-id]'],
    ['<article> elements',      'article'],
    ['<li> items',              'li'],
    ['/in/ links',              'a[href*="/in/"]'],
    ['/company/ links',         'a[href*="/company/"]'],
    ['/posts/ links',           'a[href*="/posts/"]'],
    ['span[aria-hidden=true]',  'span[aria-hidden="true"]'],
    ['[role="list"]',           '[role="list"]'],
    ['[role="article"]',        '[role="article"]'],
    ['[class*="occludable"]',   '[class*="occludable"]'],
    ['[class*="feed-shared"]',  '[class*="feed-shared"]'],
    ['[class*="actor"]',        '[class*="actor"]'],
    ['JSON-LD scripts',         'script[type="application/ld+json"]'],
    ['<code> data blocks',      'code[id]'],
  ]
  for (const [label, sel] of checks) {
    try {
      const n = document.querySelectorAll(sel).length
      if (n > 0) console.log(`  ✅  ${label.padEnd(30)} ${n}`)
    } catch { /* skip */ }
  }
  console.groupEnd()
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 & 3 — Post extraction (company posts or personal activity feed)
// ─────────────────────────────────────────────────────────────────────────────

interface ProbePost {
  author: string
  authorTitle: string
  authorProfileUrl: string
  content: string
  relativeDate: string
  daysAgo: number | null
  withinMonth: boolean
  likes: string
  comments: string
  postUrl: string
  mediaType: string
  urn: string
}

function extractPosts(): ProbePost[] {
  // Gather all candidate containers using stable attributes + structural tags
  const candidates: Element[] = [
    ...Array.from(document.querySelectorAll('[data-urn*="activity"]')),
    ...Array.from(document.querySelectorAll('[data-id*="activity"]')),
    ...Array.from(document.querySelectorAll('article')),
    ...Array.from(document.querySelectorAll('[class*="occludable-update"]')),
    ...Array.from(document.querySelectorAll('[class*="feed-shared-update"]')),
  ]

  // Remove duplicates and child elements that are inside another candidate
  const unique = [...new Set(candidates)]
  const roots = unique.filter(el =>
    !unique.some(other => other !== el && other.contains(el))
  )

  const seenUrns = new Set<string>()
  const posts: ProbePost[] = []

  for (const container of roots) {
    const urn = attr(container, 'data-urn') || attr(container, 'data-id') || ''
    if (urn && seenUrns.has(urn)) continue
    if (urn) seenUrns.add(urn)

    // Author area — look for an "actor" or "author" sub-section
    const actorEl =
      container.querySelector('[class*="actor"]') ??
      container.querySelector('[class*="author"]') ??
      container.querySelector('[class*="update-components-actor"]')

    // Name: aria-hidden spans are always the visible text in LinkedIn
    const authorNameEl =
      actorEl?.querySelector('a span[aria-hidden="true"]') ??
      actorEl?.querySelector('span[aria-hidden="true"]') ??
      container.querySelector('[class*="actor__name"] span[aria-hidden="true"]')

    const authorTitleEl =
      actorEl?.querySelector('[class*="description"] span[aria-hidden="true"]') ??
      actorEl?.querySelector('[class*="subtitle"] span[aria-hidden="true"]')

    const authorLinkEl =
      actorEl?.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
      actorEl?.querySelector<HTMLAnchorElement>('a[href*="/company/"]')

    // Post text content
    const contentEl =
      container.querySelector('[class*="commentary"]') ??
      container.querySelector('[class*="update-components-text"]') ??
      container.querySelector('[class*="feed-shared-text"]') ??
      container.querySelector('[dir="ltr"]')

    // Date — <time> is the most reliable; fall back to sub-description
    const timeEl = container.querySelector('time')
    const dateTextEl =
      timeEl ??
      actorEl?.querySelector('[class*="sub-description"] span[aria-hidden="true"]')

    const rawDate = text(dateTextEl)
    const daysAgo = parseDaysAgo(rawDate)

    // Reactions / comments
    const likesEl =
      container.querySelector('[class*="reactions-count"]') ??
      container.querySelector('[class*="social-counts"] [class*="reaction"]') ??
      container.querySelector('[aria-label*="reaction"]')

    const commentsEl =
      container.querySelector('[class*="social-counts"] a[href*="comment"]') ??
      container.querySelector('[aria-label*="comment"]') ??
      container.querySelector('[class*="comments-count"]')

    // Permalink to post
    const postLinkEl =
      container.querySelector<HTMLAnchorElement>('a[href*="/posts/"]') ??
      container.querySelector<HTMLAnchorElement>('a[href*="/feed/update/"]')

    // Media type
    const mediaType =
      container.querySelector('video, [class*="linkedin-video"]') ? 'video' :
      container.querySelector('[class*="image"] img') ? 'image' :
      container.querySelector('[class*="document"]') ? 'document' :
      container.querySelector('[class*="poll"]') ? 'poll' : 'text'

    const author  = text(authorNameEl)
    const content = text(contentEl).slice(0, 500)
    if (!author && !content) continue

    posts.push({
      author,
      authorTitle:      text(authorTitleEl),
      authorProfileUrl: cleanUrl(attr(authorLinkEl, 'href')),
      content,
      relativeDate:     rawDate,
      daysAgo,
      withinMonth:      daysAgo !== null && daysAgo <= 30,
      likes:            text(likesEl),
      comments:         text(commentsEl),
      postUrl:          cleanUrl(attr(postLinkEl, 'href')),
      mediaType,
      urn,
    })
  }

  return posts
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — People extraction with CORE member detection
// ─────────────────────────────────────────────────────────────────────────────

interface ProbePerson {
  name: string
  title: string
  location: string
  profileUrl: string
  imageUrl: string
  isCore: boolean
  activityUrl: string  // direct link to their recent posts
}

function extractPeople(): ProbePerson[] {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')
  const seen = new Set<string>()
  const people: ProbePerson[] = []

  for (const anchor of Array.from(anchors)) {
    const href = attr(anchor, 'href').split('?')[0]
    if (!href || seen.has(href)) continue
    // Must be a real profile URL (at least /in/something)
    if (!/^(https?:\/\/www\.linkedin\.com)?\/in\/[^/]+/.test(href)) continue
    seen.add(href)

    const card = cardRoot(anchor)

    // Name: aria-hidden span inside or near the anchor
    const nameEl =
      card.querySelector('a[href*="/in/"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="title"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="name"] span[aria-hidden="true"]') ??
      card.querySelector('span[aria-hidden="true"]')

    // Title: look for subtitle/description elements
    const titleEl =
      card.querySelector('[class*="subtitle"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="description"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="headline"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="position"] span[aria-hidden="true"]')

    // Location
    const locEl =
      card.querySelector('[class*="caption"] span[aria-hidden="true"]') ??
      card.querySelector('[class*="location"] span[aria-hidden="true"]')

    // Profile image
    const imgEl = card.querySelector<HTMLImageElement>('img[src*="licdn"], img[src*="profile"]') ??
                  card.querySelector<HTMLImageElement>('img')

    const name  = text(nameEl)
    const title = text(titleEl)
    if (!name && !href) continue

    const profileUrl  = cleanUrl(href)
    // Extract username from /in/USERNAME to build activity URL
    const usernameMatch = profileUrl.match(/\/in\/([^/]+)/)
    const activityUrl = usernameMatch
      ? `https://www.linkedin.com/in/${usernameMatch[1]}/recent-activity/shares/`
      : ''

    people.push({
      name,
      title,
      location:    text(locEl),
      profileUrl,
      imageUrl:    imgEl?.src ?? '',
      isCore:      isCore(title),
      activityUrl,
    })
  }

  return people
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2b — Profile page extraction (used when visiting /in/USERNAME/)
// ─────────────────────────────────────────────────────────────────────────────

function extractProfilePage() {
  const name = text(document.querySelector('h1'))
  const headline = text(
    document.querySelector('h1 ~ div') ??
    document.querySelector('[class*="headline"]') ??
    document.querySelector('[class*="pv-text-details"] .break-words')
  )
  const locationText = text(document.querySelector('[class*="t-black--light"].break-words'))

  // About section — find by h2 heading text
  let about = ''
  document.querySelectorAll('section').forEach(sec => {
    if (text(sec.querySelector('h2')).toLowerCase().includes('about') && !about)
      about = text(sec.querySelector('span[aria-hidden="true"]')).slice(0, 400)
  })

  // Experience entries
  const experience: { title: string; company: string; duration: string }[] = []
  document.querySelectorAll('section').forEach(sec => {
    if (!text(sec.querySelector('h2')).toLowerCase().includes('experience')) return
    sec.querySelectorAll('li').forEach(li => {
      const spans = Array.from(li.querySelectorAll('span[aria-hidden="true"]'))
        .map(s => text(s)).filter(Boolean)
      if (spans.length >= 2)
        experience.push({ title: spans[0], company: spans[1], duration: spans[2] ?? '' })
    })
  })

  const currentTitle = experience[0]?.title ?? ''
  const username     = window.location.pathname.match(/\/in\/([^/]+)/)?.[1] ?? ''
  const activityUrl  = username
    ? `https://www.linkedin.com/in/${username}/recent-activity/shares/`
    : `${window.location.href}recent-activity/shares/`

  return { name, headline, location: locationText, about, currentTitle, isCore: isCore(headline || currentTitle), experience, activityUrl }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main probe runner
// ─────────────────────────────────────────────────────────────────────────────

function runProbe() {
  const { type: pageType, hint } = detectPage()
  console.group(`%c[LinkedIn Probe v3]  ${hint || pageType}  —  ${location.pathname}`, 'color:#0a66c2;font-weight:bold;font-size:14px')

  domInventory()

  // ── STEP 1 or STEP 3: Post pages ─────────────────────────────────────────
  if (pageType === 'company-posts' || pageType === 'profile-posts') {
    const posts    = extractPosts()
    const inMonth  = posts.filter(p => p.withinMonth)
    const older    = posts.filter(p => !p.withinMonth && p.daysAgo !== null)
    const noDate   = posts.filter(p => p.daysAgo === null)

    console.group(
      `%c📰 Posts: ${posts.length} total  |  ✅ Last 30 days: ${inMonth.length}  |  🕓 Older: ${older.length}  |  ❓ No date: ${noDate.length}`,
      'font-weight:bold'
    )

    if (posts.length === 0) {
      console.warn('❌ No posts found. Scroll down to load posts then click Probe again.')
    } else {
      console.group(`✅ Last 30 days (${inMonth.length})`)
      inMonth.forEach((p, i) => {
        console.log(
          `[${i+1}] ${p.daysAgo}d ago | ${p.mediaType} | 👤 ${p.author || '??'} (${p.authorTitle || '??'})`
        )
        console.log(`     "${p.content.slice(0, 140)}"`)
        console.log(`     👍 ${p.likes||'?'}  💬 ${p.comments||'?'}  🔗 ${p.postUrl||'(no link)'}`)
      })
      console.groupEnd()

      if (older.length > 0) {
        console.group(`🕓 Older than 30 days (${older.length})`)
        older.forEach(p => console.log(`  ${p.daysAgo}d ago — ${p.author}: ${p.content.slice(0,80)}`))
        console.groupEnd()
      }

      // Field coverage
      const c = (f: keyof ProbePost) => posts.filter(p => !!p[f]).length
      console.table({
        'Has author':   c('author'),
        'Has content':  c('content'),
        'Has date':     c('relativeDate'),
        'Has post URL': c('postUrl'),
        'Has likes':    c('likes'),
        'Has URN':      c('urn'),
        'Total posts':  posts.length,
      })
    }
    console.groupEnd()
  }

  // ── Search results: people ────────────────────────────────────────────────
  if (pageType === 'search-people') {
    const people  = extractPeople()
    const core    = people.filter(p => p.isCore)

    console.group(
      `%c🔎 Search results: ${people.length} people found  |  ⭐ Core members: ${core.length}`,
      'font-weight:bold'
    )

    if (people.length === 0) {
      console.warn('❌ No people extracted. Scroll the page to load all cards, then click Probe again.')
    } else {
      if (core.length > 0) {
        console.group(`⭐ Core / decision-makers (${core.length})`)
        core.forEach((p, i) => {
          console.log(`[${i+1}] ${p.name || '??'} — ${p.title || '??'}`)
          console.log(`     Profile: ${p.profileUrl}`)
          console.log(`     Posts:   ${p.activityUrl}  ← open for Step 3`)
        })
        console.groupEnd()
      }

      console.group(`All results (${people.length})`)
      people.forEach((p, i) =>
        console.log(`[${i+1}] ${p.isCore ? '⭐' : '  '} ${p.name || '??'} — ${p.title || '??'} | ${p.location || '?'} | ${p.profileUrl}`)
      )
      console.groupEnd()

      const c = (f: keyof ProbePerson) => people.filter(p => !!p[f]).length
      console.table({
        'Has name':       c('name'),
        'Has title':      c('title'),
        'Has location':   c('location'),
        'Has profile URL':c('profileUrl'),
        'Has image':      c('imageUrl'),
        'Is core':        c('isCore'),
        'Total':          people.length,
      })
    }
    console.groupEnd()
  }

  // ── STEP 2: People page ───────────────────────────────────────────────────
  if (pageType === 'company-people') {
    const people  = extractPeople()
    const core    = people.filter(p => p.isCore)
    const nonCore = people.filter(p => !p.isCore)

    console.group(
      `%c👥 People: ${people.length} total  |  ⭐ Core members: ${core.length}  |  Others: ${nonCore.length}`,
      'font-weight:bold'
    )

    if (people.length === 0) {
      console.warn('❌ No people found. Scroll down to load cards then click Probe again.')
    } else {
      if (core.length > 0) {
        console.group(`⭐ Core members (${core.length}) — visit their Activity tab for Step 3`)
        core.forEach((p, i) => {
          console.log(`[${i+1}] ${p.name || '??'} — ${p.title || '??'}`)
          console.log(`     Profile:  ${p.profileUrl}`)
          console.log(`     Posts:    ${p.activityUrl}  ← open this for Step 3`)
          console.log(`     Location: ${p.location || '?'} | Has photo: ${!!p.imageUrl}`)
        })
        console.groupEnd()
      }

      if (nonCore.length > 0) {
        console.group(`Others (${nonCore.length})`)
        nonCore.forEach((p, i) =>
          console.log(`[${i+1}] ${p.name || '??'} — ${p.title || '??'} | ${p.profileUrl}`)
        )
        console.groupEnd()
      }

      // Field coverage
      const c = (f: keyof ProbePerson) => people.filter(p => !!p[f]).length
      console.table({
        'Has name':       c('name'),
        'Has title':      c('title'),
        'Has location':   c('location'),
        'Has profile URL':c('profileUrl'),
        'Has image':      c('imageUrl'),
        'Is core':        c('isCore'),
        'Total people':   people.length,
      })

      console.log('%c📋 Copy these URLs to visit each core member\'s activity feed:', 'color:#0a66c2;font-weight:bold')
      core.forEach(p => console.log(`  ${p.name}: ${p.activityUrl}`))
    }
    console.groupEnd()
  }

  // ── Profile page (main /in/USERNAME/) ────────────────────────────────────
  if (pageType === 'profile') {
    const prof = extractProfilePage()
    console.group(`%c👤 Profile: ${prof.name || '??'}`, 'font-weight:bold')
    console.log('Name:         ', prof.name        || '❌')
    console.log('Headline:     ', prof.headline    || '❌')
    console.log('Location:     ', prof.location    || '❌')
    console.log('About:        ', prof.about?.slice(0,200) || '❌')
    console.log('Current role: ', prof.currentTitle || '❌')
    console.log('Is core:      ', prof.isCore ? '⭐ YES' : 'No')
    console.log('Experience entries:', prof.experience.length)
    prof.experience.forEach((e, i) =>
      console.log(`  [${i+1}] ${e.title} @ ${e.company} (${e.duration})`)
    )
    console.log(
      `%c📋 For Step 3, visit their posts: ${prof.activityUrl}`,
      'color:#0a66c2;font-weight:bold'
    )
    console.groupEnd()
  }

  // ── Unrecognized page ─────────────────────────────────────────────────────
  if (pageType === 'other') {
    console.warn(
      '⚠ Unrecognized page. Navigate to one of:\n' +
      '  Step 1 → https://www.linkedin.com/company/NAME/posts/\n' +
      '  Step 2 → https://www.linkedin.com/company/NAME/people/\n' +
      '  Step 3 → https://www.linkedin.com/in/USERNAME/recent-activity/shares/'
    )
  }

  console.groupEnd()
}

// ── Floating probe button ─────────────────────────────────────────────────────

function injectButton() {
  if (document.getElementById('ls-li-probe-v3')) return

  const { type, hint } = detectPage()

  // Label changes per step so user knows which phase they're on
  const labels: Partial<Record<PageType, string>> = {
    'company-posts':   '🔍 Step 1: Company Posts',
    'company-people':  '🔍 Step 2: Find People',
    'profile-posts':   '🔍 Step 3: Member Posts',
    'profile':         '🔍 Step 3: Profile',
  }
  const label = labels[type] ?? '🔍 Probe DOM'

  const btn = document.createElement('button')
  btn.id = 'ls-li-probe-v3'
  btn.textContent = label
  Object.assign(btn.style, {
    position: 'fixed', bottom: '80px', right: '20px', zIndex: '999999',
    background: type === 'company-people' ? '#7c3aed' : '#0a66c2',
    color: '#fff', border: 'none', borderRadius: '24px',
    padding: '10px 18px', fontSize: '13px', fontWeight: '600',
    fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
  })

  btn.onmouseenter = () => { btn.style.opacity = '0.85' }
  btn.onmouseleave = () => { btn.style.opacity = '1' }

  btn.onclick = () => {
    btn.textContent = '⏳ Probing…'
    btn.disabled = true
    setTimeout(() => {
      try {
        runProbe()
        btn.textContent = '✅ Check console (F12)'
      } catch (e) {
        console.error('[LinkedIn Probe]', e)
        btn.textContent = '❌ Error — check console'
      }
      btn.disabled = false
      setTimeout(() => { btn.textContent = label }, 4000)
    }, 150)
  }

  document.body.appendChild(btn)
}

// ── Init + SPA navigation re-inject ──────────────────────────────────────────

injectButton()

let lastHref = location.href
new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href
    const old = document.getElementById('ls-li-probe-v3')
    if (old) old.remove()
    setTimeout(injectButton, 1500)
  }
}).observe(document.body, { childList: true, subtree: true })
