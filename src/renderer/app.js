'use strict';

/* global api */

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const modal = $('#modal');

let state = null; // settings, projects, invoices, running timer...
let view = 'timer';
let report = null; // entries + summary for the selected range
let week = null; // this week's report, for the timer screen
let range = { preset: 'week', from: 0, to: 0, projectId: '' };
let expanded = null; // entry id whose detail row is open
let draft = { projectId: '', task: '' }; // timer inputs, kept across re-renders

// ---------------------------------------------------------------- utilities

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function call(channel, payload) {
  const res = await api.invoke(channel, payload);
  if (!res.ok) {
    toast(res.error, true);
    throw new Error(res.error);
  }
  return res.data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

function duration(entry, now = Date.now()) {
  const end = entry.end || (entry.running ? now : entry.start);
  return Math.max(0, Math.round((end - entry.start) / 1000 - (entry.discardedSec || 0)));
}
function hms(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(sec / 3600)}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}
function hm(sec) {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function money(n) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency || 'USD' }).format(n);
  } catch {
    return Number(n).toFixed(2);
  }
}
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateLabel = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const pad = (n) => String(n).padStart(2, '0');
const dayInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dtInput = (ts) => { const d = new Date(ts); return `${dayInput(ts)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
const startOfWeek = (ts) => addDays(startOfDay(ts), -((new Date(ts).getDay() + 6) % 7));
const startOfMonth = (ts, offset = 0) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime(); };

function presetRange(preset) {
  const now = Date.now();
  switch (preset) {
    case 'today': return [startOfDay(now), addDays(startOfDay(now), 1)];
    case 'week': return [startOfWeek(now), addDays(startOfWeek(now), 7)];
    case 'lastweek': return [addDays(startOfWeek(now), -7), startOfWeek(now)];
    case 'month': return [startOfMonth(now), startOfMonth(now, 1)];
    case 'lastmonth': return [startOfMonth(now, -1), startOfMonth(now)];
    default: return [range.from, range.to];
  }
}

const project = (id) => state.projects.find((p) => p.id === id);
const activeProjects = () => state.projects.filter((p) => !p.archived);
function projectTag(id) {
  const p = project(id);
  return p ? `<span class="swatch" data-color="${esc(p.color)}"></span> ${esc(p.name)}` : '<span class="muted">No project</span>';
}
function projectOptions(selected, { includeNone = true, all = false } = {}) {
  const list = state.projects.filter((p) => !p.archived || p.id === selected);
  return (
    (all ? '<option value="">All projects</option>' : includeNone ? '<option value="">No project</option>' : '') +
    list.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.client ? ` — ${esc(p.client)}` : ''}</option>`).join('')
  );
}
function rateOf(p) {
  return p && typeof p.rate === 'number' ? p.rate : Number(state.settings.defaultRate) || 0;
}
function amountOf(entry) {
  const p = project(entry.projectId);
  if (p && p.billable === false) return 0;
  return (duration(entry) / 3600) * rateOf(p);
}
const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

/** Inline style attributes are blocked by the page's CSP, so sizes and colours are applied here. */
function applyDynamicStyles(root) {
  root.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${el.dataset.w}%`));
  root.querySelectorAll('[data-h]').forEach((el) => (el.style.height = `${el.dataset.h}%`));
  root.querySelectorAll('[data-color]').forEach((el) => (el.style.background = el.dataset.color));
}

// ---------------------------------------------------------------- data loading

async function refresh() {
  state = await call('state:get');
  const now = Date.now();
  week = await call('report:get', { from: startOfWeek(now), to: addDays(startOfWeek(now), 7) });
  if (['timesheet', 'reports'].includes(view)) {
    [range.from, range.to] = presetRange(range.preset);
    report = await call('report:get', { from: range.from, to: range.to, projectId: range.projectId });
  }
  render();
  if (state.pendingIdle && !modal.open) showIdlePrompt(state.pendingIdle.seconds);
  else if (state.managed && state.managed.managed && !state.settings.consentAt && !modal.open) showConsentPrompt();
}

// ---------------------------------------------------------------- views

function render() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const running = state.running;
  $('#navStatus').innerHTML = running
    ? `<span class="dot on"></span>Tracking`
    : `<span class="dot"></span>Not tracking`;
  main.innerHTML = managedBanner() + { timer: viewTimer, timesheet: viewTimesheet, reports: viewReports, projects: viewProjects, invoices: viewInvoices, settings: viewSettings }[view]();
  applyDynamicStyles(main);
  if (view === 'timer') updateClock();
}

function managedBanner() {
  const m = state.managed;
  if (!m || !m.managed) return '';
  const org = esc(m.orgName || 'your organization');
  if (m.state === 'deactivated' || m.state === 'purged') {
    return `<div class="mbanner stop">This device has been ${m.state === 'purged' ? 'wiped and ' : ''}deactivated by ${org}. Tracking has stopped.</div>`;
  }
  if (state.trackingBlocked) {
    return `<div class="mbanner warn">Tracking is <b>paused by your administrator</b> at ${org}. The timer is disabled until they resume it.</div>`;
  }
  const where = m.state === 'offline' ? ' · can\'t reach server, recording locally' : '';
  return `<div class="mbanner">Managed by <b>${org}</b> · reporting to ${esc(m.serverUrl)} as ${esc(m.employeeEmail)}${where}</div>`;
}

function liveHtml() {
  const r = state.running;
  if (!r) return '<span class="muted small">Start the timer to begin recording time and activity.</span>';
  const pills = [];
  if (r.live.idle) pills.push('<span class="pill warn">Idle – no keyboard or mouse input</span>');
  else if (r.live.app) pills.push(`<span class="pill">Active app: ${esc(r.live.app)}</span>`);
  if (r.live.ai) pills.push(`<span class="pill ai">AI tool in use: ${esc(r.live.ai)}</span>`);
  const dur = duration(r.entry);
  if (dur > 30) pills.push(`<span class="pill">Activity ${pct(r.entry.activeSec, dur)}%</span>`);
  if (r.entry.aiSec > 0) pills.push(`<span class="pill ai">AI ${hm(r.entry.aiSec)}</span>`);
  if (r.entry.aiBackground.length) pills.push(`<span class="pill">AI running in background: ${esc(r.entry.aiBackground.join(', '))}</span>`);
  if (state.settings.screenshotsEnabled) pills.push(`<span class="pill">Screenshots: ${r.entry.screenshots.length}</span>`);
  return pills.join('');
}

function viewTimer() {
  const r = state.running;
  const now = Date.now();
  const today = week.entries.filter((e) => e.start >= startOfDay(now));
  const todaySec = today.reduce((s, e) => s + duration(e), 0);
  const todayAmount = today.reduce((s, e) => s + amountOf(e), 0);
  const limit = Number(state.settings.weeklyHourLimit) || 0;
  const weekSec = week.entries.reduce((s, e) => s + duration(e), 0);
  const weekAmount = week.entries.reduce((s, e) => s + amountOf(e), 0);
  const weekAi = week.entries.reduce((s, e) => s + (e.aiSec || 0), 0);
  const over = limit > 0 && weekSec > limit * 3600;
  const projectId = r ? r.entry.projectId : draft.projectId;

  return `
  <h1>Timer</h1>
  <div class="card timer-card">
    <div>
      <div class="clock num" id="clock">0:00:00</div>
      <div class="live" id="live">${liveHtml()}</div>
    </div>
    <div class="timer-fields">
      <select id="timerProject" ${r ? 'disabled' : ''} aria-label="Project">${projectOptions(projectId)}</select>
      <input id="timerTask" placeholder="What are you working on?" value="${esc(r ? r.entry.task : draft.task)}" ${r ? 'disabled' : ''} aria-label="Task">
    </div>
    <button class="big ${r ? 'stop' : 'go'}" data-action="${r ? 'stop' : 'start'}" ${!r && state.trackingBlocked ? 'disabled title="Paused by your administrator"' : ''}>${r ? 'Stop' : 'Start'}</button>
  </div>
  <div class="grid">
    <div class="card"><h2>Today</h2><div class="stat" id="todayStat">${hm(todaySec)}</div><div class="muted small">${money(todayAmount)}</div></div>
    <div class="card"><h2>This week</h2><div class="stat">${hm(weekSec)}</div>
      ${limit ? `<div class="meter ${over ? 'over' : ''}"><i data-w="${pct(weekSec, limit * 3600)}"></i></div><div class="muted small">${over ? 'Over the' : 'of'} ${limit} h weekly limit</div>` : `<div class="muted small">No weekly limit set</div>`}
    </div>
    <div class="card"><h2>Earned this week</h2><div class="stat">${money(weekAmount)}</div><div class="muted small">billable time × rate</div></div>
    <div class="card"><h2>AI-assisted this week</h2><div class="stat ai">${hm(weekAi)}</div><div class="muted small">${pct(weekAi, week.summary.trackedSec)}% of tracked time</div></div>
  </div>
  <div class="card">
    <div class="row"><h2>Today's entries</h2><span class="spacer"></span><button data-action="manual">Add time manually</button></div>
    ${entryTable(today, { compact: true })}
  </div>`;
}

function entryBadges(e) {
  const out = [];
  if (e.running) out.push('<span class="pill accent">running</span>');
  if (e.manual) out.push('<span class="pill warn">manual</span>');
  if (e.edited) out.push('<span class="pill warn">time edited</span>');
  if (e.recovered) out.push('<span class="pill warn">recovered</span>');
  if (e.invoiceNumber) out.push(`<span class="pill">${esc(e.invoiceNumber)}</span>`);
  return out.join(' ');
}

function entryTable(entries, { compact = false } = {}) {
  if (!entries.length) return '<div class="empty">No time recorded for this period.</div>';
  const rows = entries
    .map((e) => {
      const dur = duration(e);
      const tracked = !e.manual && dur > 0;
      const row = `
      <tr class="clickable" data-action="expand" data-id="${esc(e.id)}">
        ${compact ? '' : `<td class="num">${esc(dateLabel(e.start))}</td>`}
        <td>${projectTag(e.projectId)}<div class="muted small">${esc(e.task)}</div></td>
        <td class="num">${time(e.start)} – ${e.end ? time(e.end) : 'now'} ${entryBadges(e)}</td>
        <td class="r num">${hm(dur)}</td>
        <td class="r num">${tracked ? pct(e.activeSec, dur) + '%' : '<span class="muted">—</span>'}</td>
        <td class="r num">${tracked && e.aiSec > 0 ? `<span class="pill ai">${pct(e.aiSec, dur)}%</span>` : tracked ? '0%' : '<span class="muted">—</span>'}</td>
        <td class="r num">${money(amountOf(e))}</td>
      </tr>`;
      return row + (expanded === e.id ? `<tr class="detail"><td colspan="${compact ? 6 : 7}">${entryDetail(e)}</td></tr>` : '');
    })
    .join('');
  return `<table><thead><tr>${compact ? '' : '<th>Date</th>'}<th>Project / task</th><th>Time</th><th class="r">Duration</th><th class="r">Activity</th><th class="r">AI</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function barList(obj, { ai = false, total, limit = 8, format = hm } = {}) {
  const items = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!items.length) return '<div class="muted small">Nothing recorded.</div>';
  const max = total || items[0][1];
  return `<div class="bars">${items
    .map(([name, v]) => `<div class="name" title="${esc(name)}">${esc(name)}</div><div class="bar"><i class="${ai ? 'ai' : ''}" data-w="${pct(v, max)}"></i></div><div class="num small">${format(v)}</div>`)
    .join('')}</div>`;
}

function entryDetail(e) {
  const locked = e.running || e.invoiceId;
  const actions = locked
    ? `<span class="muted small">${e.running ? 'Stop the timer to edit this entry.' : `Locked – included on invoice ${esc(e.invoiceNumber)}.`}</span>`
    : `<button data-action="editEntry" data-id="${esc(e.id)}">Edit</button><button class="danger" data-action="deleteEntry" data-id="${esc(e.id)}">Delete</button>`;
  if (e.manual) {
    return `<div class="row"><span class="muted">Manual entry – no activity data was recorded.</span><span class="spacer"></span>${actions}</div>${e.notes ? `<p>${esc(e.notes)}</p>` : ''}`;
  }
  const maxTotal = Math.max(1, ...(e.timeline || []).map((b) => b.total));
  const timeline = (e.timeline || [])
    .map((b) => `<i class="${b.ai > b.total * 0.25 ? 'ai' : ''}" data-h="${Math.max(10, pct(b.active, maxTotal))}" title="${time(b.t)} – activity ${pct(b.active, b.total)}%, AI ${pct(b.ai, b.total)}%"></i>`)
    .join('');
  const shots = (e.screenshots || [])
    .map((s) => `<div class="shot"><img src="${esc(s.url)}" alt="Screenshot at ${time(s.ts)}" title="${time(s.ts)}"><button data-action="deleteShot" data-id="${esc(e.id)}" data-file="${esc(s.file)}" title="Delete screenshot">✕</button></div>`)
    .join('');
  return `
  <div class="row"><span class="small muted">Idle ${hm(e.idleSec || 0)} · discarded ${hm(e.discardedSec || 0)}${e.stopReason && e.stopReason !== 'user' ? ` · stopped: ${esc(e.stopReason)}` : ''}</span><span class="spacer"></span>${actions}</div>
  ${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
  ${timeline ? `<div class="timeline">${timeline}</div><div class="legend"><span><span class="swatch" data-color="var(--accent)"></span> activity per 10 min</span><span><span class="swatch" data-color="var(--ai)"></span> AI tool in use</span></div>` : ''}
  <div class="detail-grid">
    <div><h2>Applications</h2>${barList(e.apps, { limit: 6 })}</div>
    <div><h2>AI tools used</h2>${barList(e.aiTools, { ai: true, limit: 6 })}
      ${(e.aiBackground || []).length ? `<div class="small muted">Also running in the background: ${esc(e.aiBackground.join(', '))}</div>` : ''}</div>
  </div>
  ${shots ? `<h2>Screenshots</h2><div class="shots">${shots}</div>` : ''}`;
}

function rangeBar() {
  const presets = { today: 'Today', week: 'This week', lastweek: 'Last week', month: 'This month', lastmonth: 'Last month', custom: 'Custom' };
  return `
  <div class="row card">
    <select id="rangePreset" aria-label="Period">${Object.entries(presets).map(([k, v]) => `<option value="${k}" ${range.preset === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <input type="date" id="rangeFrom" value="${dayInput(range.from)}" aria-label="From">
    <span class="muted">to</span>
    <input type="date" id="rangeTo" value="${dayInput(addDays(range.to, -1))}" aria-label="To">
    <select id="rangeProject" aria-label="Project filter">${projectOptions(range.projectId, { all: true })}</select>
    <span class="spacer"></span>
    ${view === 'timesheet' ? '<button data-action="manual">Add time manually</button>' : ''}
    <button data-action="exportCsv">Export CSV</button>
  </div>`;
}

function viewTimesheet() {
  const s = report.summary;
  return `
  <h1>Timesheet</h1>
  ${rangeBar()}
  <div class="grid">
    <div class="card"><h2>Total</h2><div class="stat">${hm(s.totalSec)}</div><div class="muted small">${s.entryCount} entries</div></div>
    <div class="card"><h2>Billable</h2><div class="stat">${hm(s.billableSec)}</div><div class="muted small">${money(s.earnings)}</div></div>
    <div class="card"><h2>Manual time</h2><div class="stat">${hm(s.manualSec)}</div><div class="muted small">${pct(s.manualSec, s.totalSec)}% of total</div></div>
  </div>
  <div class="card">${entryTable(report.entries)}</div>`;
}

function viewReports() {
  const s = report.summary;
  const days = Object.values(s.byDay).sort((a, b) => a.day.localeCompare(b.day));
  const maxDay = Math.max(1, ...days.map((d) => d.sec));
  const dayBars = days.length
    ? `<div class="bars">${days
        .map((d) => `<div class="name">${esc(dateLabel(new Date(d.day + 'T12:00').getTime()))}</div><div class="bar"><i data-w="${pct(d.sec - d.aiSec, maxDay)}"></i><i class="ai" data-w="${pct(d.aiSec, maxDay)}"></i></div><div class="num small">${hm(d.sec)}</div>`)
        .join('')}</div>`
    : '<div class="muted small">Nothing recorded.</div>';
  const projects = Object.values(s.byProject).sort((a, b) => b.sec - a.sec);
  const maxProject = Math.max(1, ...projects.map((p) => p.sec));
  const projectBars = projects.length
    ? `<div class="bars">${projects
        .map((p) => `<div class="name">${esc(p.name)}</div><div class="bar"><i data-w="${pct(p.sec - p.aiSec, maxProject)}"></i><i class="ai" data-w="${pct(p.aiSec, maxProject)}"></i></div><div class="num small">${hm(p.sec)} · ${money(p.amount)}</div>`)
        .join('')}</div>`
    : '<div class="muted small">Nothing recorded.</div>';
  const legend = '<div class="legend"><span><span class="swatch" data-color="var(--accent)"></span> Tracked time</span><span><span class="swatch" data-color="var(--ai)"></span> AI tool in the foreground</span></div>';
  return `
  <h1>Activity &amp; AI</h1>
  ${rangeBar()}
  <div class="grid">
    <div class="card"><h2>Tracked time</h2><div class="stat">${hm(s.trackedSec)}</div><div class="muted small">plus ${hm(s.manualSec)} manual</div></div>
    <div class="card"><h2>Activity level</h2><div class="stat">${s.activityPct == null ? '—' : s.activityPct + '%'}</div><div class="muted small">time with keyboard / mouse input</div></div>
    <div class="card"><h2>Idle time</h2><div class="stat">${hm(s.idleSec)}</div><div class="muted small">kept in the timesheet</div></div>
    <div class="card"><h2>AI-assisted time</h2><div class="stat ai">${hm(s.aiSec)}</div><div class="muted small">${s.aiPct == null ? 'no tracked time' : s.aiPct + '% of tracked time'}</div></div>
  </div>
  <div class="cols2">
    <div class="card"><h2>AI tools used (foreground time)</h2>${barList(s.aiTools, { ai: true })}
      <p class="muted small">Counted whenever an AI tool or AI web page is the active window while the timer runs.</p></div>
    <div class="card"><h2>AI tools running in the background</h2>${barList(s.aiBackground, { ai: true, format: (n) => `${n} session${n === 1 ? '' : 's'}` })}
      <p class="muted small">Desktop AI apps and local model runners that were open during a tracked session, even when not in focus.</p></div>
    <div class="card"><h2>Time by day</h2>${legend}${dayBars}</div>
    <div class="card"><h2>Time by project</h2>${legend}${projectBars}</div>
    <div class="card"><h2>Top applications</h2>${barList(s.apps, { limit: 12 })}</div>
  </div>`;
}

function viewProjects() {
  const rows = state.projects
    .map(
      (p) => `<tr>
      <td><span class="swatch" data-color="${esc(p.color)}"></span> ${esc(p.name)} ${p.archived ? '<span class="pill">archived</span>' : ''}</td>
      <td>${esc(p.client) || '<span class="muted">—</span>'}</td>
      <td class="r num">${p.billable === false ? '<span class="muted">non-billable</span>' : money(rateOf(p)) + ' / h' + (typeof p.rate === 'number' ? '' : ' <span class="muted small">(default)</span>')}</td>
      <td class="r"><button class="link" data-action="editProject" data-id="${esc(p.id)}">Edit</button>
        <button class="link" data-action="archiveProject" data-id="${esc(p.id)}" data-archived="${p.archived ? '' : '1'}">${p.archived ? 'Restore' : 'Archive'}</button></td>
    </tr>`
    )
    .join('');
  return `
  <h1>Projects</h1>
  <div class="card">
    <div class="row"><h2>Projects and clients</h2><span class="spacer"></span><button class="primary" data-action="editProject">New project</button></div>
    ${rows ? `<table><thead><tr><th>Project</th><th>Client</th><th class="r">Rate</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No projects yet. Create one to assign time and rates.</div>'}
  </div>`;
}

function viewInvoices() {
  const rows = [...state.invoices]
    .reverse()
    .map(
      (i) => `<tr>
      <td class="num">${esc(i.number)}</td><td>${esc(i.billTo)}</td>
      <td class="num">${esc(new Date(i.date).toLocaleDateString())}</td>
      <td class="r num">${i.lines.reduce((s, l) => s + l.hours, 0).toFixed(2)} h</td>
      <td class="r num">${money(i.total)}</td>
      <td>${i.paid ? '<span class="pill accent">paid</span>' : '<span class="pill warn">unpaid</span>'}</td>
      <td class="r"><button class="link" data-action="invoicePdf" data-id="${esc(i.id)}">Save PDF</button>
        <button class="link" data-action="invoicePaid" data-id="${esc(i.id)}" data-paid="${i.paid ? '' : '1'}">${i.paid ? 'Mark unpaid' : 'Mark paid'}</button>
        <button class="link danger" data-action="invoiceDelete" data-id="${esc(i.id)}">Delete</button></td>
    </tr>`
    )
    .join('');
  return `
  <h1>Invoices</h1>
  <div class="card">
    <div class="row"><h2>Invoices</h2><span class="spacer"></span><button class="primary" data-action="newInvoice">New invoice</button></div>
    ${rows ? `<table><thead><tr><th>Number</th><th>Bill to</th><th>Issued</th><th class="r">Hours</th><th class="r">Total</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No invoices yet. An invoice collects the uninvoiced billable time for a period and locks those entries.</div>'}
  </div>`;
}

function viewSettings() {
  const s = state.settings;
  const text = (key, label, type = 'text', extra = '') => `<label class="field">${label}<input name="${key}" type="${type}" value="${esc(s[key])}" ${extra}></label>`;
  const check = (key, label, hint = '') => `<label class="check wide"><input type="checkbox" name="${key}" ${s[key] ? 'checked' : ''}><span>${label}${hint ? `<br><span class="muted small">${hint}</span>` : ''}</span></label>`;
  const audit = state.audit.length
    ? `<table><tbody>${state.audit.slice(0, 60).map((a) => `<tr><td class="num small muted">${esc(new Date(a.ts).toLocaleString())}</td><td class="small">${esc(a.detail)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted small">Nothing yet.</div>';
  return `
  <h1>Settings</h1>
  <form id="settingsForm">
  <div class="card"><h2>Contractor and client</h2><div class="form">
    ${text('contractorName', 'Your name / business')}${text('contractorEmail', 'Email', 'email')}
    ${text('clientCompany', 'Default client')}${text('currency', 'Currency code', 'text', 'maxlength="3" size="4"')}
    ${text('defaultRate', 'Default hourly rate', 'number', 'min="0" step="0.01"')}${text('weeklyHourLimit', 'Weekly hour limit (0 = none)', 'number', 'min="0" step="1"')}
    <label class="field wide">Address (shown on invoices)<textarea name="contractorAddress" rows="2">${esc(s.contractorAddress)}</textarea></label>
  </div></div>

  <div class="card"><h2>Activity tracking</h2><div class="form">
    ${text('sampleIntervalSec', 'Sample every (seconds)', 'number', 'min="2" max="60"')}
    ${text('idleThresholdMin', 'Count as idle after (minutes)', 'number', 'min="1"')}
    <label class="field">When I come back from being idle<select name="idleAction">
      ${[['ask', 'Ask me whether to keep the idle time'], ['discard', 'Always discard the idle time'], ['keep', 'Always keep the idle time']].map(([v, l]) => `<option value="${v}" ${s.idleAction === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    ${text('autoStopIdleMin', 'Stop the timer after idle for (minutes, 0 = never)', 'number', 'min="0"')}
    ${check('minimizeToTray', 'Keep running in the tray / menu bar when the window is closed')}
  </div></div>

  <div class="card"><h2>AI usage detection</h2><div class="form">
    ${check('detectAi', 'Detect AI tools while the timer is running', 'Recognises AI assistants, AI coding tools, local model runners and AI media tools by application name, window title and (on macOS) browser address.')}
    ${check('captureBrowserUrl', 'Read the address of the active browser tab (macOS)', 'More accurate than window titles. Only used in memory to match AI sites; addresses are never saved.')}
    <label class="field wide">Additional AI tools to detect — one per line, as <code>Name | keyword, keyword</code>
      <textarea name="customAiTools" rows="4" placeholder="Internal Assistant | assistant.example.com, Acme Assistant">${esc(s.customAiTools)}</textarea></label>
  </div></div>

  <div class="card"><h2>Screenshots</h2><div class="form">
    ${check('screenshotsEnabled', 'Capture a screenshot periodically while the timer is running', 'Stored only on this computer. You can review and delete any screenshot from the timesheet.')}
    ${text('screenshotIntervalMin', 'Roughly every (minutes)', 'number', 'min="1"')}
  </div></div>

  <div class="card"><h2>Invoices</h2><div class="form">
    ${text('invoicePrefix', 'Invoice number prefix')}${text('invoiceTaxPct', 'Tax %', 'number', 'min="0" step="0.01"')}
    <label class="field wide">Default terms / notes<textarea name="invoiceTerms" rows="2">${esc(s.invoiceTerms)}</textarea></label>
  </div></div>

  <div class="row"><button class="primary" type="submit">Save settings</button></div>
  </form>

  <div class="card" id="permissions" hidden></div>

  ${managedCard()}

  <div class="card"><h2>What this app records</h2>
    <p>Worker Tracker only records while <b>you</b> have started the timer, and it is always visible in the tray / menu bar.</p>
    <ul class="plain">
      <li>Start and end time of each session, idle time, and whether there was keyboard or mouse input (never which keys).</li>
      <li>Which application was in the foreground, added up per session.</li>
      <li>How long an AI tool was in the foreground, and which AI apps were running.</li>
      <li>Screenshots, only if enabled above.</li>
    </ul>
    <p class="muted small">Window titles and browser addresses are used in memory for AI detection and are not saved. Everything is stored on this computer; nothing is uploaded. You share data by exporting a timesheet or invoice.</p>
    <div class="row"><button type="button" data-action="openData">Open data folder</button><button type="button" data-action="backup">Export all data (JSON)</button>
    <span class="muted small">Version ${esc(state.version)}</span></div>
  </div>

  <div class="card"><h2>Change log</h2>
    <p class="muted small">Manual entries, edits, deletions and discarded idle time are logged here and included in the full data export.</p>${audit}</div>`;
}

async function renderPermissions() {
  const box = $('#permissions');
  if (!box) return;
  const p = await call('permissions:get');
  if (!p.needed) return;
  const line = (ok, label, pane) => `<div class="row"><span class="pill ${ok ? 'accent' : 'warn'}">${ok ? 'granted' : 'not granted'}</span><span>${label}</span><span class="spacer"></span>${ok ? '' : `<button type="button" data-action="openPermission" data-pane="${pane}">Open System Settings</button>`}</div>`;
  box.hidden = false;
  box.innerHTML = `<h2>macOS permissions</h2>
    ${line(p.accessibility, 'Accessibility – needed to read window titles for AI detection', 'accessibility')}
    ${line(p.screen, 'Screen Recording – needed only if screenshots are enabled', 'screen')}
    <div class="row"><span class="pill">on request</span><span>Automation – macOS asks the first time a browser address is read</span><span class="spacer"></span><button type="button" data-action="openPermission" data-pane="automation">Open System Settings</button></div>`;
}

// ---------------------------------------------------------------- dialogs

function openModal(html, onSubmit) {
  modal.innerHTML = `<form method="dialog">${html}</form>`;
  const form = $('form', modal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return modal.close();
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), e.submitter ? e.submitter.value : '');
      modal.close();
    } catch {
      /* error already shown; keep the dialog open */
    }
  });
  modal.showModal();
}

const actions = (label = 'Save') => `<div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">${label}</button></div>`;

function entryDialog(entry) {
  const now = Date.now();
  const e = entry || { projectId: draft.projectId, task: '', notes: '', start: now - 3600000, end: now };
  openModal(
    `<h1>${entry ? 'Edit entry' : 'Add time manually'}</h1>
    <div class="form">
      <label class="field wide">Project<select name="projectId">${projectOptions(e.projectId)}</select></label>
      <label class="field wide">Task<input name="task" value="${esc(e.task)}"></label>
      <label class="field">Start<input name="start" type="datetime-local" required value="${dtInput(e.start)}"></label>
      <label class="field">End<input name="end" type="datetime-local" required value="${dtInput(e.end)}"></label>
      <label class="field wide">Notes<textarea name="notes" rows="2">${esc(e.notes)}</textarea></label>
    </div>
    <p class="muted small">${entry && !entry.manual ? 'Changing the times of a tracked entry flags it as edited.' : 'Manual time is flagged in timesheets and exports and has no activity data.'}</p>
    ${actions()}`,
    async (f) => {
      const payload = { projectId: f.projectId, task: f.task, notes: f.notes, start: new Date(f.start).getTime(), end: new Date(f.end).getTime() };
      if (entry) {
        // Only send times when the user actually changed them (inputs have minute precision).
        if (f.start === dtInput(entry.start) && f.end === dtInput(entry.end)) {
          delete payload.start;
          delete payload.end;
        }
        await call('entry:update', { id: entry.id, ...payload });
      } else {
        await call('entry:addManual', payload);
      }
    }
  );
}

function projectDialog(p) {
  p = p || { name: '', client: state.settings.clientCompany, rate: null, billable: true, color: '#2563eb' };
  openModal(
    `<h1>${p.id ? 'Edit project' : 'New project'}</h1>
    <div class="form">
      <label class="field wide">Name<input name="name" required value="${esc(p.name)}"></label>
      <label class="field wide">Client<input name="client" value="${esc(p.client)}"></label>
      <label class="field">Hourly rate (blank = default)<input name="rate" type="number" min="0" step="0.01" value="${p.rate == null ? '' : esc(p.rate)}"></label>
      <label class="field">Colour<input name="color" type="color" value="${esc(p.color)}"></label>
      <label class="check wide"><input type="checkbox" name="billable" ${p.billable !== false ? 'checked' : ''}><span>Billable</span></label>
    </div>${actions()}`,
    (f) => call('project:save', { id: p.id, name: f.name, client: f.client, rate: f.rate, color: f.color, billable: f.billable === 'on' })
  );
}

function invoiceDialog() {
  const [from, to] = presetRange('lastmonth');
  const boxes = state.projects
    .filter((p) => p.billable !== false)
    .map((p) => `<label class="check"><input type="checkbox" name="p_${esc(p.id)}" checked><span>${esc(p.name)}${p.client ? ` <span class="muted">— ${esc(p.client)}</span>` : ''}</span></label>`)
    .join('');
  openModal(
    `<h1>New invoice</h1>
    <div class="form">
      <label class="field wide">Bill to<input name="billTo" required value="${esc(state.settings.clientCompany)}"></label>
      <label class="field">From<input name="from" type="date" required value="${dayInput(from)}"></label>
      <label class="field">To (inclusive)<input name="to" type="date" required value="${dayInput(addDays(to, -1))}"></label>
      <div class="wide"><div class="muted small">Projects to include</div>${boxes}
        <label class="check"><input type="checkbox" name="p_" checked><span>Time without a project</span></label></div>
      <label class="field wide">Notes / terms<textarea name="notes" rows="2">${esc(state.settings.invoiceTerms)}</textarea></label>
    </div>${actions('Create invoice')}`,
    async (f) => {
      const projectIds = Object.keys(f).filter((k) => k.startsWith('p_')).map((k) => k.slice(2));
      const inv = await call('invoice:create', {
        billTo: f.billTo, notes: f.notes, projectIds,
        from: new Date(f.from + 'T00:00').getTime(), to: addDays(new Date(f.to + 'T00:00').getTime(), 1),
      });
      toast(`Invoice ${inv.number} created`);
    }
  );
}

function showIdlePrompt(seconds) {
  openModal(
    `<h1>You were away</h1>
    <p>No keyboard or mouse input was detected for <b>${hm(seconds)}</b> while the timer was running.</p>
    <p class="muted">Keep that time if you were working away from the computer (a call, a meeting). Discard it to remove it from the timesheet.</p>
    <div class="dialog-actions"><button value="discard">Discard idle time</button><button class="primary" value="keep">Keep it</button></div>`,
    (_f, choice) => call('timer:idleDecision', { discard: choice === 'discard' })
  );
}

function confirmDialog(title, message, label, onConfirm) {
  openModal(`<h1>${esc(title)}</h1><p>${esc(message)}</p><div class="dialog-actions"><button value="cancel">Cancel</button><button class="primary" value="ok">${esc(label)}</button></div>`, onConfirm);
}

function managedCard() {
  const m = state.managed || {};
  if (!m.managed) {
    return `<div class="card"><h2>Managed mode (enterprise)</h2>
      <p class="small">Connect this device to a central Worker Tracker server so an administrator receives time, activity and AI-usage reports and can manage the device remotely. Enrollment is normally done by IT during setup.</p>
      <form id="enrollForm" class="form">
        <label class="field">Server address<input name="serverUrl" placeholder="https://tracker.yourcompany.com" required></label>
        <label class="field">Your work email<input name="employeeEmail" type="email" placeholder="you@company.com" required></label>
        <label class="field wide">Enrollment token<input name="enrollmentToken" placeholder="from your administrator" required></label>
        <div class="wide"><button class="primary" type="submit">Enroll this device</button></div>
      </form>
      <p class="muted small">Enrolling turns on monitoring and shows you exactly what is collected before any data is sent.</p></div>`;
  }
  const dead = m.state === 'deactivated' || m.state === 'purged';
  const statusPill = dead ? `<span class="pill warn">${esc(m.state)}</span>`
    : state.trackingBlocked ? '<span class="pill warn">paused by admin</span>'
    : m.state === 'offline' ? '<span class="pill warn">offline — recording locally</span>' : '<span class="pill accent">connected</span>';
  return `<div class="card"><h2>Managed mode (enterprise)</h2>
    <div class="row"><div>Reporting to <b>${esc(m.orgName || 'your organization')}</b> ${statusPill}</div></div>
    <ul class="plain small">
      <li>Server: ${esc(m.serverUrl)}</li>
      <li>Enrolled as: ${esc(m.employeeEmail)}</li>
      <li>Last successful sync: ${m.lastSync ? esc(new Date(m.lastSync).toLocaleString()) : 'not yet'}</li>
      ${m.lastError ? `<li class="muted">Last error: ${esc(m.lastError)}</li>` : ''}
    </ul>
    <p class="muted small">Your administrator can pause tracking or erase this device's data remotely. Only summaries are sent — never window titles, typed text or browser addresses.</p>
    ${dead ? '' : '<div class="row"><button type="button" data-action="managedSync">Sync now</button><button type="button" class="danger" data-action="managedLeave">Disable managed mode</button></div>'}</div>`;
}

function showConsentPrompt() {
  const org = esc((state.managed && state.managed.orgName) || 'your organization');
  openModal(
    `<h1>Workplace monitoring notice</h1>
    <p>This computer is enrolled in <b>${org}</b>'s Worker Tracker. While you run the timer, the app records and sends to your employer's server:</p>
    <ul class="plain">
      <li>start/stop times, active and idle time;</li>
      <li>which applications were in the foreground, and for how long;</li>
      <li>how long AI tools were used and which ones, tied to the project/task you selected;</li>
      <li>screenshots, only if your administrator has enabled them.</li>
    </ul>
    <p class="muted small">Window titles, typed text and browser addresses are <b>not</b> sent. The app stays visible in your tray/menu bar whenever it is recording. Your administrator can pause or stop tracking and can erase this device's data remotely. Questions about this program should go to your employer.</p>
    <div class="dialog-actions"><button class="primary" value="ok">I understand</button></div>`,
    () => call('managed:consent')
  );
}

// ---------------------------------------------------------------- events

function updateClock() {
  const clock = $('#clock');
  if (clock) clock.textContent = hms(state && state.running ? duration(state.running.entry) : 0);
}
setInterval(updateClock, 1000);

function findEntry(id) {
  return [...(report ? report.entries : []), ...(week ? week.entries : [])].find((e) => e.id === id);
}

async function setView(next) {
  view = next;
  expanded = null;
  await refresh();
  if (view === 'settings') renderPermissions();
  main.scrollTop = 0;
}

document.addEventListener('click', async (ev) => {
  const nav = ev.target.closest('#nav button');
  if (nav) return setView(nav.dataset.view);
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (action !== 'expand') ev.stopPropagation();
  switch (action) {
    case 'start':
      await call('timer:start', { projectId: draft.projectId, task: draft.task });
      break;
    case 'stop':
      await call('timer:stop');
      draft.task = '';
      break;
    case 'expand':
      expanded = expanded === id ? null : id;
      render();
      break;
    case 'manual': entryDialog(); break;
    case 'editEntry': entryDialog(findEntry(id)); break;
    case 'deleteEntry':
      confirmDialog('Delete this entry?', 'The time, its activity data and any screenshots will be removed. The deletion is noted in the change log.', 'Delete', () => call('entry:delete', { id }));
      break;
    case 'deleteShot': await call('screenshot:delete', { entryId: id, file: el.dataset.file }); break;
    case 'exportCsv': {
      const res = await call('export:csv', { from: range.from, to: range.to, projectId: range.projectId });
      if (res.saved) toast('Timesheet exported');
      break;
    }
    case 'editProject': projectDialog(id ? project(id) : null); break;
    case 'archiveProject': await call('project:setArchived', { id, archived: !!el.dataset.archived }); break;
    case 'newInvoice': invoiceDialog(); break;
    case 'invoicePdf': await call('invoice:pdf', { id }); break;
    case 'invoicePaid': await call('invoice:setPaid', { id, paid: !!el.dataset.paid }); break;
    case 'invoiceDelete':
      confirmDialog('Delete this invoice?', 'Its time entries become uninvoiced and editable again.', 'Delete', () => call('invoice:delete', { id }));
      break;
    case 'openData': await call('data:openFolder'); break;
    case 'backup': {
      const res = await call('export:backup');
      if (res.saved) toast('Data exported');
      break;
    }
    case 'openPermission': await call('permissions:open', { pane: el.dataset.pane }); break;
    case 'managedSync':
      try { await call('managed:syncNow'); toast('Synced with server'); } catch { /* shown */ }
      break;
    case 'managedLeave':
      confirmDialog('Disable managed mode?', 'This device will stop reporting to the server. Your administrator may re-enroll it or act on the server side. Local tracking continues.', 'Disable', () => call('managed:leave'));
      break;
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'timerTask') draft.task = ev.target.value;
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'timerProject') draft.projectId = t.value;
  else if (t.id === 'rangePreset') {
    range.preset = t.value;
    await refresh();
  } else if (t.id === 'rangeFrom' || t.id === 'rangeTo') {
    const from = new Date($('#rangeFrom').value + 'T00:00').getTime();
    const to = new Date($('#rangeTo').value + 'T00:00').getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    range = { ...range, preset: 'custom', from, to: addDays(Math.max(from, to), 1) };
    await refresh();
  } else if (t.id === 'rangeProject') {
    range.projectId = t.value;
    await refresh();
  }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id === 'enrollForm') {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    try {
      await call('managed:enroll', { serverUrl: f.serverUrl, employeeEmail: f.employeeEmail, enrollmentToken: f.enrollmentToken });
      toast('Device enrolled');
    } catch { /* error shown via toast */ }
    return;
  }
  if (ev.target.id !== 'settingsForm') return;
  ev.preventDefault();
  const form = ev.target;
  const payload = Object.fromEntries(new FormData(form));
  form.querySelectorAll('input[type=checkbox]').forEach((c) => (payload[c.name] = c.checked));
  payload.currency = String(payload.currency || 'USD').toUpperCase();
  await call('settings:save', payload);
  toast('Settings saved');
});

api.on('tick', (snapshot) => {
  if (!state) return;
  state.running = snapshot;
  if (view === 'timer') {
    const live = $('#live');
    if (live) live.innerHTML = liveHtml();
  }
});
// Avoid re-rendering (and losing form input) while the user is typing in Settings.
api.on('changed', () => {
  if (view === 'settings' && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  refresh().then(() => view === 'settings' && renderPermissions());
});
api.on('idle-return', ({ seconds }) => showIdlePrompt(seconds));
api.on('auto-stopped', ({ minutes }) => toast(`Timer stopped automatically after ${minutes} minutes without input`));
api.on('managed-state', (status) => {
  if (!state) return;
  const was = state.managed && state.managed.state;
  state.managed = status;
  // A remote deactivate/purge or pause should surface immediately, even mid-typing.
  if (status.state !== was || (view !== 'settings')) refresh();
});

[range.from, range.to] = presetRange('week');
refresh();
