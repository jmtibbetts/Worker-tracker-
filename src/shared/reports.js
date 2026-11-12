'use strict';

/** Billable/tracked seconds of an entry: wall time minus any discarded idle time. */
function entryDuration(entry, now = Date.now()) {
  const end = entry.end || (entry.running ? now : entry.start);
  const sec = (end - entry.start) / 1000 - (entry.discardedSec || 0);
  return Math.max(0, Math.round(sec));
}

function projectMap(projects) {
  const map = new Map();
  for (const p of projects) map.set(p.id, p);
  return map;
}

function rateFor(project, settings) {
  if (project && typeof project.rate === 'number' && !Number.isNaN(project.rate)) return project.rate;
  return Number(settings.defaultRate) || 0;
}

function isBillable(project) {
  return !project || project.billable !== false;
}

function entryAmount(entry, project, settings, now) {
  if (!isBillable(project)) return 0;
  return (entryDuration(entry, now) / 3600) * rateFor(project, settings);
}

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Monday 00:00 (local time) of the week containing ts. */
function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function filterEntries(entries, { from, to, projectId } = {}) {
  return entries.filter(
    (e) => (from == null || e.start >= from) && (to == null || e.start < to) && (!projectId || e.projectId === projectId)
  );
}

function addTo(obj, key, value) {
  obj[key] = (obj[key] || 0) + value;
}

function summarize(entries, projects, settings, now = Date.now()) {
  const pmap = projectMap(projects);
  const s = {
    totalSec: 0,
    billableSec: 0,
    manualSec: 0,
    trackedSec: 0, // automatically tracked (non-manual) time
    activeSec: 0,
    idleSec: 0,
    aiSec: 0,
    earnings: 0,
    entryCount: entries.length,
    byProject: {},
    byDay: {},
    apps: {},
    aiTools: {},
    aiBackground: {},
  };
  for (const e of entries) {
    const project = pmap.get(e.projectId);
    const dur = entryDuration(e, now);
    const amount = entryAmount(e, project, settings, now);
    s.totalSec += dur;
    if (isBillable(project)) s.billableSec += dur;
    if (e.manual) s.manualSec += dur;
    else s.trackedSec += dur;
    s.activeSec += e.activeSec || 0;
    s.idleSec += e.idleSec || 0;
    s.aiSec += e.aiSec || 0;
    s.earnings += amount;

    const pid = e.projectId || '';
    if (!s.byProject[pid]) s.byProject[pid] = { projectId: pid, name: project ? project.name : 'No project', sec: 0, aiSec: 0, amount: 0 };
    s.byProject[pid].sec += dur;
    s.byProject[pid].aiSec += e.aiSec || 0;
    s.byProject[pid].amount += amount;

    const dk = dayKey(e.start);
    if (!s.byDay[dk]) s.byDay[dk] = { day: dk, sec: 0, aiSec: 0 };
    s.byDay[dk].sec += dur;
    s.byDay[dk].aiSec += e.aiSec || 0;

    for (const [app, sec] of Object.entries(e.apps || {})) addTo(s.apps, app, sec);
    for (const [tool, sec] of Object.entries(e.aiTools || {})) addTo(s.aiTools, tool, sec);
    for (const tool of e.aiBackground || []) addTo(s.aiBackground, tool, 1);
  }
  s.activityPct = s.trackedSec ? Math.min(100, Math.round((s.activeSec / s.trackedSec) * 100)) : null;
  s.aiPct = s.trackedSec ? Math.min(100, Math.round((s.aiSec / s.trackedSec) * 100)) : null;
  return s;
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection from free-text fields.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${dayKey(ts)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toCsv(entries, projects, settings, now = Date.now()) {
  const pmap = projectMap(projects);
  const header = [
    'Date', 'Start', 'End', 'Project', 'Client', 'Task', 'Notes', 'Hours', 'Duration (s)', 'Type', 'Billable',
    'Rate', 'Amount', 'Activity %', 'Idle (s)', 'Discarded idle (s)', 'AI time (s)', 'AI %', 'AI tools used',
    'AI tools running in background', 'Top applications', 'Screenshots', 'Invoice',
  ];
  const rows = [header];
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  for (const e of sorted) {
    const project = pmap.get(e.projectId);
    const dur = entryDuration(e, now);
    const pct = (n) => (e.manual || !dur ? '' : Math.min(100, Math.round(((n || 0) / dur) * 100)));
    const topApps = Object.entries(e.apps || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, sec]) => `${name} (${Math.round(sec / 60)}m)`)
      .join('; ');
    const aiTools = Object.entries(e.aiTools || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, sec]) => `${name} (${Math.round(sec / 60)}m)`)
      .join('; ');
    rows.push([
      dayKey(e.start), isoLocal(e.start), isoLocal(e.end), project ? project.name : '', project ? project.client || '' : '',
      e.task || '', e.notes || '', (dur / 3600).toFixed(2), dur, e.manual ? 'manual' : 'tracked',
      isBillable(project) ? 'yes' : 'no', rateFor(project, settings), entryAmount(e, project, settings, now).toFixed(2),
      pct(e.activeSec), Math.round(e.idleSec || 0), Math.round(e.discardedSec || 0), Math.round(e.aiSec || 0), pct(e.aiSec),
      aiTools, (e.aiBackground || []).join('; '), topApps, (e.screenshots || []).length, e.invoiceNumber || '',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Build invoice line items (one per project) from a set of entries. */
function buildInvoiceLines(entries, projects, settings) {
  const pmap = projectMap(projects);
  const lines = new Map();
  for (const e of entries) {
    const project = pmap.get(e.projectId);
    const key = e.projectId || '';
    if (!lines.has(key)) {
      lines.set(key, { projectId: key, description: project ? project.name : 'General work', sec: 0, aiSec: 0, rate: rateFor(project, settings) });
    }
    const line = lines.get(key);
    line.sec += entryDuration(e);
    line.aiSec += e.aiSec || 0;
  }
  return [...lines.values()].map((l) => {
    const hours = Math.round((l.sec / 3600) * 100) / 100;
    return { ...l, hours, amount: Math.round(hours * l.rate * 100) / 100 };
  });
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency || ''}`.trim();
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function invoiceHtml(inv) {
  const m = (n) => esc(money(n, inv.currency));
  const date = (ts) => esc(new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
  const rows = inv.lines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="n">${l.hours.toFixed(2)}</td><td class="n">${m(l.rate)}</td><td class="n">${m(l.amount)}</td></tr>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c2330;margin:48px;font-size:13px;line-height:1.5}
  h1{font-size:28px;margin:0;letter-spacing:.02em} .top{display:flex;justify-content:space-between;margin-bottom:36px}
  .muted{color:#667085} .cols{display:flex;gap:64px;margin-bottom:28px} .cols h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#667085;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;margin-top:8px} th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#667085;border-bottom:2px solid #1c2330;padding:8px 6px}
  td{padding:10px 6px;border-bottom:1px solid #e4e7ec} .n{text-align:right;font-variant-numeric:tabular-nums}
  .totals{margin-left:auto;width:280px;margin-top:16px} .totals div{display:flex;justify-content:space-between;padding:4px 6px}
  .totals .grand{font-weight:700;font-size:16px;border-top:2px solid #1c2330;margin-top:6px;padding-top:10px}
  .foot{margin-top:40px;white-space:pre-wrap}
  </style></head><body>
  <div class="top"><div><h1>INVOICE</h1><div class="muted">${esc(inv.number)}</div></div>
  <div style="text-align:right"><div><b>Issued:</b> ${date(inv.date)}</div><div><b>Period:</b> ${date(inv.from)} – ${date(inv.to - 1)}</div>${inv.paid ? '<div><b>Status:</b> Paid</div>' : ''}</div></div>
  <div class="cols"><div><h3>From</h3><div><b>${esc(inv.fromName)}</b></div><div>${esc(inv.fromEmail)}</div><div style="white-space:pre-wrap">${esc(inv.fromAddress)}</div></div>
  <div><h3>Bill to</h3><div><b>${esc(inv.billTo)}</b></div></div></div>
  <table><thead><tr><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals"><div><span>Subtotal</span><span>${m(inv.subtotal)}</span></div>
  ${inv.taxPct ? `<div><span>Tax (${esc(inv.taxPct)}%)</span><span>${m(inv.tax)}</span></div>` : ''}
  <div class="grand"><span>Total due</span><span>${m(inv.total)}</span></div></div>
  <div class="foot muted">${esc(inv.notes)}</div>
  </body></html>`;
}

module.exports = {
  entryDuration, rateFor, isBillable, entryAmount, dayKey, startOfWeek, filterEntries, summarize, toCsv,
  buildInvoiceLines, invoiceHtml, money,
};
