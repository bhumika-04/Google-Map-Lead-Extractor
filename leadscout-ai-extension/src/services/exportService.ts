import type { Lead } from '@/types/lead'
import type { ResearchResult } from '@/types/research'

type EnrichedResult = ResearchResult & { lead?: Lead }

export function exportToJSON(leads: Lead[], filename = 'leads.json'): void {
  const clean = leads.map(({ id: _id, ...rest }) => rest)
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' })
  downloadBlob(blob, filename)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function esc(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function row2(label: string, value: string | undefined): string {
  if (!value) return ''
  return `<tr><td style="color:#888;width:130px;padding:3px 8px 3px 0;font-size:10pt;">${esc(label)}</td>
          <td style="padding:3px 0;font-size:10pt;">${esc(value)}</td></tr>`
}

export function exportToDoc(
  leads: Lead[],
  researchMap: Map<number, ResearchResult>,
  filename = 'leadscout-export.doc',
): void {
  const sections = leads.map((lead) => {
    const r = lead.id ? researchMap.get(lead.id) : undefined
    const icpLabel = lead.icpScore != null
      ? `${lead.icpScore}/100${lead.icpStatus ? ` — ${lead.icpStatus.replace('_', ' ')}` : ''}`
      : ''

    return `
<div style="page-break-inside:avoid; margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid #ddd;">
  <h2 style="margin:0 0 4px; font-size:13pt; color:#1a56db;">${esc(lead.companyName)}</h2>
  <p style="margin:0 0 8px; color:#666; font-size:9pt;">${esc(lead.city)}${lead.category ? ` · ${esc(lead.category)}` : lead.keyword ? ` · ${esc(lead.keyword)}` : ''}</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr>
      <td style="vertical-align:top;width:50%;padding-right:16px;">
        <table style="border-collapse:collapse;">
          ${row2('Phone', lead.phone)}
          ${row2('Website', lead.website)}
          ${row2('Address', lead.address)}
          ${row2('Rating', lead.rating != null ? `${lead.rating}★ (${lead.reviewCount ?? 0} reviews)` : '')}
          ${row2('ICP Score', icpLabel)}
          ${row2('Map Score', lead.confidence != null ? String(Math.round(lead.confidence * 100)) : '')}
        </table>
      </td>
      <td style="vertical-align:top;width:50%;">
        <table style="border-collapse:collapse;">
          ${row2('Industry', lead.industry ?? r?.industry)}
          ${row2('Company Type', lead.companyType ?? r?.companyType)}
          ${row2('Team Size', lead.teamSize ?? r?.employeeCount)}
          ${row2('Annual Turnover', lead.annualTurnover ?? r?.annualTurnover)}
          ${row2('Directors / Owner', lead.decisionMaker ?? r?.decisionMaker)}
          ${row2('CIN', lead.cin)}
          ${row2('UAN (EPFO)', lead.uan)}
          ${row2('Email', r?.email)}
          ${row2('LinkedIn', r?.linkedIn)}
        </table>
      </td>
    </tr>
  </table>
  ${lead.icpReason ? `<p style="margin:8px 0 0;color:#555;font-size:9pt;font-style:italic;">${esc(lead.icpReason)}</p>` : ''}
  ${r?.summary ? `<p style="margin:6px 0 0;font-size:10pt;">${esc(r.summary)}</p>` : ''}
  ${r?.services?.length ? `<p style="margin:4px 0 0;font-size:9pt;color:#555;">Services: ${esc(r.services.join(', '))}</p>` : ''}
</div>`
  }).join('\n')

  const date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>LeadScout Export</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>90</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; margin: 1.5cm 2cm; color: #222; }
  h1   { font-size: 16pt; color: #1a56db; margin-bottom: 4px; }
  h2   { font-size: 13pt; }
  p    { margin: 4px 0; }
  td   { vertical-align: top; }
</style>
</head>
<body>
<h1>LeadScout — Lead Database</h1>
<p style="color:#888;font-size:9pt;">${leads.length} leads exported on ${date}</p>
<hr style="margin:12px 0;border:1px solid #ddd;">
${sections}
</body>
</html>`

  const blob = new Blob([html], { type: 'application/msword' })
  downloadBlob(blob, filename)
}

// ─── PDF Export ───────────────────────────────────────────────────────────────
// Opens a print-optimised window. One lead per page. Browser File → Save as PDF.

// Builds the fullest available address. Google Maps list cards often yield only
// a fragment (e.g. "Shop 34"), so we append the research 'headquarters' region,
// merging in only the parts not already present to avoid "Indore, Indore".
function composeAddress(lead: Lead | undefined, headquarters: string | undefined): string {
  const bits: string[] = []
  const street = lead?.address?.trim()
  if (street) bits.push(street)

  const hq = headquarters?.trim()
  if (hq) {
    const existing = bits.join(', ').toLowerCase()
    const newParts = hq.split(',').map((s) => s.trim()).filter((p) => p && !existing.includes(p.toLowerCase()))
    if (newParts.length) bits.push(newParts.join(', '))
  }

  if (bits.length === 0 && lead?.city) bits.push(lead.city.trim())
  return bits.join(', ')
}

export function exportToPdf(results: EnrichedResult[]): void {
  const date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

  const sections = results.map((r) => {
    const lead = r.lead
    const conf = Math.round(r.confidence * 100)
    const icpBadge = lead?.icpScore != null
      ? `<span class="badge icp">${lead.icpScore}/100 ICP · ${(lead.icpStatus ?? '').replace('_', ' ')}</span>`
      : ''
    const confBadge = `<span class="badge conf">${conf}% research confidence</span>`

    const chips = [r.industry, r.companyType, r.supplierBuyerType?.replace('_', ' ')].filter(Boolean)
      .map((v) => `<span class="chip">${esc(v!)}</span>`).join('')

    function pills(items: string[] | undefined, cls = '') {
      if (!items?.length) return ''
      return `<div class="pills ${cls}">${items.map((i) => `<span class="pill">${esc(i)}</span>`).join('')}</div>`
    }

    function section2(title: string, html: string) {
      return `<div class="section"><div class="section-title">${title}</div>${html}</div>`
    }

    function kv(label: string, value: string | undefined | null, badge = '') {
      if (!value) return ''
      return `<div class="kv"><span class="kv-label">${label}</span><span class="kv-value">${esc(value)}${badge}</span></div>`
    }

    // Full-width row — label on its own line, value wraps freely below.
    // Used for long values (address) so nothing is clipped or squeezed.
    function kvWide(label: string, value: string | undefined | null) {
      if (!value) return ''
      return `<div class="kv-wide"><span class="kv-label">${label}</span><span class="kv-value">${esc(value)}</span></div>`
    }

    const estBadge = (verified: boolean | undefined) =>
      verified === false ? ' <span class="est">Est.</span>' : verified ? ' <span class="ok">✓</span>' : ''

    const displayName = lead?.companyName ?? `Lead #${r.leadId}`
    return `
<section class="lead-page">
  <div class="lp-body">
  <!-- Header -->
  <div class="lead-header">
    <div class="lead-header-left">
      <div class="eyebrow">LeadScout &middot; Research Dossier</div>
      <h1>${esc(displayName)}</h1>
      <div class="meta">${esc(lead?.city ?? '')}${lead?.category ? ` &middot; ${esc(lead.category)}` : lead?.keyword ? ` &middot; ${esc(lead.keyword)}` : ''}</div>
      <div class="chips">${chips}${icpBadge}${confBadge}</div>
    </div>
    ${lead?.icpScore != null ? `
    <div class="icp-circle ${lead.icpScore >= 80 ? 'hi' : lead.icpScore >= 60 ? 'med' : 'lo'}">
      <div class="icp-num">${lead.icpScore}</div>
      <div class="icp-sub">ICP</div>
    </div>` : ''}
  </div>

  ${r.tagline ? `<p class="tagline">&ldquo;${esc(r.tagline)}&rdquo;</p>` : ''}
  ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}

  <div class="two-col">
    <!-- Left column -->
    <div>
      ${section2('Contact', `
        ${kv('Phone', lead?.phone)}
        ${kv('Alt Phone', r.alternatePhone)}
        ${kv('Email', r.email)}
        ${kv('WhatsApp', r.whatsapp ? r.whatsapp.replace('https://wa.me/', '') : undefined)}
        ${kv('Website', r.website ?? lead?.website)}
        ${kvWide('Address', composeAddress(lead, r.headquarters ?? undefined))}
      `)}

      ${section2('Enrichment', `
        ${kv('Industry', r.industry ?? lead?.industry)}
        ${kv('Company Type', r.companyType ?? lead?.companyType)}
        ${kv('Team Size', (r.employeeCount ?? lead?.teamSize), estBadge(lead?.teamSizeVerified))}
        ${kv('Annual Turnover', (r.annualTurnover ?? lead?.annualTurnover), estBadge(lead?.turnoverVerified))}
        ${kv('Founded', r.yearFounded ? String(r.yearFounded) : undefined)}
        ${kv('CIN', lead?.cin)}
        ${kv('UAN (EPFO)', lead?.uan)}
        ${kv('Rating', lead?.rating != null ? `${lead.rating}★ (${lead.reviewCount ?? 0} reviews)` : undefined)}
      `)}

      ${r.decisionMaker || lead?.decisionMaker ? section2('Directors / Decision Maker', `
        ${kv('Name', r.decisionMaker ?? lead?.decisionMaker)}
        ${kv('LinkedIn', r.decisionMakerLinkedIn)}
      `) : ''}
    </div>

    <!-- Right column -->
    <div>
      ${lead?.icpReason ? section2('ICP Reason', `<p class="reason">${esc(lead.icpReason)}</p>`) : ''}
      ${lead?.icpScoreBreakdown ? `<div class="kv-block"><span class="kv-label">Score Breakdown</span><span class="mono">${esc(lead.icpScoreBreakdown)}</span></div>` : ''}

      ${r.services?.length ? section2('Services & Products', pills(r.services)) : ''}
      ${r.majorClients?.length ? section2('Major Clients', pills(r.majorClients)) : ''}
      ${r.certifications?.length ? section2('Certifications', pills(r.certifications)) : ''}
      ${r.currentSoftware?.length ? section2('Current Software / ERP', pills(r.currentSoftware, 'mono-pills')) : ''}

      ${r.expansionSignals?.length ? section2('Expansion Signals', `<ul class="bullet-list green">${r.expansionSignals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`) : ''}
      ${r.painPoints?.length ? section2('Pain Points', `<ul class="bullet-list orange">${r.painPoints.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`) : ''}
      ${r.exportMarkets?.length ? section2('Export Markets', pills(r.exportMarkets)) : ''}
    </div>
  </div>

  ${r.teamMembers?.length ? section2('Key People', `
    <div class="team-grid">
      ${r.teamMembers.map((m) => `<div class="team-card"><div class="avatar">${m.name.charAt(0).toUpperCase()}</div><div><div class="tm-name">${esc(m.name)}</div><div class="tm-role">${esc(m.role)}</div></div></div>`).join('')}
    </div>
  `) : ''}

  ${r.sources?.length ? `
  <div class="sources">
    <div class="section-title">Sources</div>
    ${r.sources.map((s) => `<div class="source-row"><span class="source-label">${esc(s.label)}</span><span class="source-url">${esc(s.url)}</span></div>`).join('')}
  </div>` : r.sourceUrl ? `<div class="sources"><span class="source-label">Source: </span><span class="source-url">${esc(r.sourceUrl)}</span></div>` : ''}
  </div>
  <footer class="lead-foot">
    <span class="lf-brand">LeadScout <span>Research Dossier</span></span>
    <span class="lf-name">${esc(displayName)}</span>
    <span class="lf-date">${date}</span>
  </footer>
</section>`
  }).join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LeadScout Research Results — ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 9pt; color: #1a1a1a; background: #fff; }

  /* Each lead is its own page; flex column pins the footer near the bottom */
  .lead-page {
    page-break-after: always;
    display: flex;
    flex-direction: column;
    min-height: 24.5cm;
  }
  .lead-page:last-child { page-break-after: avoid; }
  .lp-body { flex: 1 1 auto; }

  /* Header */
  .lead-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 10px; border-bottom: 2px solid #1a56db; margin-bottom: 12px; }
  .lead-header-left { flex: 1; min-width: 0; }
  .eyebrow { font-size: 7pt; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #1a56db; margin-bottom: 3px; }
  h1 { font-size: 17pt; color: #0f2b5b; letter-spacing: -0.01em; margin-bottom: 3px; line-height: 1.15; }
  .meta { font-size: 9pt; color: #64748b; margin-bottom: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 7.5pt; padding: 2px 7px; background: #f0f4ff; border: 1px solid #c7d7fb; border-radius: 999px; color: #1a56db; }
  .badge { font-size: 7.5pt; padding: 2px 7px; border-radius: 999px; border: 1px solid; }
  .badge.icp { background: #f0fff4; border-color: #34d399; color: #065f46; }
  .badge.conf { background: #f9fafb; border-color: #d1d5db; color: #555; }

  /* ICP circle */
  .icp-circle { width: 56px; height: 56px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 2.5px solid; flex-shrink: 0; margin-left: 16px; }
  .icp-circle.hi { border-color: #10b981; background: #ecfdf5; }
  .icp-circle.med { border-color: #3b82f6; background: #eff6ff; }
  .icp-circle.lo { border-color: #f59e0b; background: #fffbeb; }
  .icp-num { font-size: 14pt; font-weight: 700; line-height: 1; }
  .icp-circle.hi .icp-num { color: #065f46; }
  .icp-circle.med .icp-num { color: #1d4ed8; }
  .icp-circle.lo .icp-num { color: #92400e; }
  .icp-sub { font-size: 7pt; color: #888; }

  .tagline { font-style: italic; color: #555; font-size: 9pt; margin: 4px 0 8px; }
  .summary { color: #333; font-size: 9pt; line-height: 1.55; margin-bottom: 12px; background: #f9fafb; border-left: 3px solid #3b82f6; padding: 8px 12px; border-radius: 0 4px 4px 0; }

  /* Two column layout */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin-bottom: 12px; align-items: start; }

  /* Sections */
  .section { margin-bottom: 12px; break-inside: avoid; }
  .section-title { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; margin-bottom: 5px; padding-bottom: 3px; border-bottom: 1px solid #e2e8f0; }

  /* Key-value rows — a grid keeps every label and value aligned in a column */
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 2px 10px; font-size: 8.5pt; padding: 3px 0; border-bottom: 1px solid #f1f5f9; }
  .kv:last-child { border-bottom: 0; }
  .kv-label { color: #64748b; }
  .kv-value { color: #0f172a; font-weight: 500; word-break: break-word; }
  /* Full-width row (address) — label above, value wraps freely below, never clipped */
  .kv-wide { font-size: 8.5pt; padding: 4px 0; border-bottom: 1px solid #f1f5f9; }
  .kv-wide .kv-label { display: block; color: #64748b; margin-bottom: 1px; }
  .kv-wide .kv-value { display: block; color: #0f172a; font-weight: 500; line-height: 1.45; word-break: break-word; }
  .kv-block { margin-bottom: 8px; }
  .mono { font-family: monospace; font-size: 7.5pt; color: #444; }

  /* Verified badges */
  .est { font-size: 7pt; padding: 1px 4px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 3px; color: #92400e; }
  .ok  { font-size: 7pt; padding: 1px 4px; background: #d1fae5; border: 1px solid #6ee7b7; border-radius: 3px; color: #065f46; }

  /* ICP reason */
  .reason { font-size: 8.5pt; color: #333; line-height: 1.5; }

  /* Pills */
  .pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill { font-size: 7.5pt; padding: 2px 7px; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 999px; color: #374151; }
  .mono-pills .pill { font-family: monospace; background: #f0f4ff; border-color: #c7d7fb; }

  /* Lists */
  .bullet-list { padding-left: 14px; }
  .bullet-list li { font-size: 8.5pt; color: #333; margin-bottom: 2px; line-height: 1.4; }
  .bullet-list.green li::marker { color: #10b981; }
  .bullet-list.orange li::marker { color: #f59e0b; }

  /* Team grid */
  .team-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .team-card { display: flex; align-items: center; gap: 8px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; background: #4f46e5; color: #fff; font-weight: 700; font-size: 11pt; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .tm-name { font-size: 8.5pt; font-weight: 600; color: #111; }
  .tm-role { font-size: 7.5pt; color: #777; }

  /* Sources */
  .sources { margin-top: 8px; border-top: 1px solid #e5e7eb; padding-top: 6px; }
  .source-row { display: flex; gap: 8px; font-size: 7.5pt; margin-bottom: 2px; }
  .source-label { color: #64748b; min-width: 80px; flex-shrink: 0; }
  .source-url { color: #1a56db; word-break: break-all; }

  /* Per-page footer */
  .lead-foot { margin-top: 14px; padding-top: 6px; border-top: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; font-size: 7pt; color: #94a3b8; }
  .lead-foot .lf-brand { font-weight: 700; color: #64748b; letter-spacing: 0.02em; }
  .lead-foot .lf-brand span { font-weight: 400; color: #94a3b8; }
  .team-card, .kv, .kv-wide, .pills, .bullet-list { break-inside: avoid; }

  /* Print geometry — consistent margins on every page */
  @page { size: A4; margin: 1.3cm 1.4cm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="no-print" style="padding:10px 16px;background:#f1f5f9;border-bottom:1px solid #cbd5e1;font-family:-apple-system,Arial,sans-serif;font-size:9pt;color:#475569;">
  <strong style="color:#1a56db;">LeadScout</strong> — ${results.length} lead${results.length === 1 ? '' : 's'} &middot; ${date}
  <span style="float:right;color:#94a3b8;">Choose <strong>Save as PDF</strong> as the destination in the print dialog</span>
</div>
${sections}
</body>
</html>`

  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
  // Small delay so fonts/styles settle before the print dialog
  setTimeout(() => { win.focus(); win.print() }, 400)
}
