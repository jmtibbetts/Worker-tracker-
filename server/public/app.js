'use strict';

const app = document.getElementById('app');
let token = localStorage.getItem('wt_admin_token') || '';
let me = null;
let viewEmployee = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = (sec) => { const m = Math.round((sec || 0) / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const ago = (ts) => {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

let toastTimer;
function toast(msg, isError) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); document.body.appendChild(el); }
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/v1' + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) return logout();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function logout() {
  if (token) api('/admin/logout', { method: 'POST' }).catch(() => {});
  token = '';
  me = null;
  localStorage.removeItem('wt_admin_token');
  renderLogin();
}

// ---------------------------------------------------------------- login
function renderLogin() {
  app.innerHTML = `<main><div class="card login">
    <h1>Admin sign in</h1>
    <form id="loginForm">
      <label class="field">Email<input name="email" type="email" required autocomplete="username"></label>
      <label class="field">Password<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <p class="muted small">Worker Tracker admin console.</p>
  </div></main>`;
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const data = await api('/admin/login', { method: 'POST', body: f });
      token = data.token;
      me = data.admin;
      localStorage.setItem('wt_admin_token', token);
      renderOverview();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function chrome(inner) {
  return `<header>
      <span class="logo"></span><b>Worker Tracker</b><span class="muted small" id="orgName"></span>
      <span class="spacer"></span>
      <span class="muted small">${esc(me ? me.email : '')}</span>
      <button class="link" id="signout">Sign out</button>
    </header><main>${inner}</main>`;
}

function wireChrome() {
  document.getElementById('signout').addEventListener('click', logout);
}

// ---------------------------------------------------------------- overview
async function renderOverview() {
  viewEmployee = null;
  let data, enroll;
  try {
    [data, enroll] = [await api('/admin/overview'), await api('/admin/enrollment')];
  } catch (err) {
    return toast(err.message, true);
  }
  me = data.you;
  const rows = data.employees.length
    ? data.employees.map((e) => `<tr class="clickable" data-emp="${esc(e.id)}">
        <td>${esc(e.name || e.email)}<div class="muted small">${esc(e.email)}</div></td>
        <td>${e.devices}</td>
        <td>${e.tracking ? '<span class="pill on">tracking</span>' : '<span class="pill off">paused / offline</span>'}</td>
        <td class="num">${ago(e.lastSeen)}</td>
        <td class="r"><button class="link">View</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No employees enrolled yet. Install the agent on a workstation and enroll it with the token below.</td></tr>';
  app.innerHTML = chrome(`
    <h1>Employees</h1>
    <div class="banner">Agents report only while the employee has the timer running, and the app stays visible on their machine.
      Monitoring must be disclosed to staff — see the deployment guide before rolling this out.</div>
    <div class="card"><table>
      <thead><tr><th>Employee</th><th>Devices</th><th>Status</th><th>Last check-in</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="card"><h2>Enroll a new device</h2>
      <p class="small">On the workstation, open the agent's <b>Settings → Managed mode</b>, enter the server address, the employee's email, and this enrollment token:</p>
      <p><code>${esc(enroll.enrollmentToken || '(not set)')}</code></p>
      <p class="muted small">Organization: ${esc(enroll.orgName)}. Keep this token private; anyone with it can enroll a device.</p>
    </div>`);
  document.getElementById('orgName').textContent = '· ' + data.orgName;
  wireChrome();
  app.querySelectorAll('tr[data-emp]').forEach((tr) => tr.addEventListener('click', () => renderEmployee(tr.dataset.emp)));
}

// ---------------------------------------------------------------- employee
function barList(obj, { ai = false, format = hm } = {}) {
  const items = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!items.length) return '<div class="muted small">Nothing recorded in this period.</div>';
  const max = items[0][1];
  return `<div class="bars">${items.map(([name, v]) =>
    `<div class="name" title="${esc(name)}">${esc(name)}</div><div class="bar"><i class="${ai ? 'ai' : ''}" style="width:${pct(v, max)}%"></i></div><div class="num small">${format(v)}</div>`
  ).join('')}</div>`;
}

async function renderEmployee(id) {
  let data;
  try {
    data = await api('/admin/employees/' + id);
  } catch (err) {
    return toast(err.message, true);
  }
  viewEmployee = id;
  const s = data.summary;
  const emp = data.employee;
  const deviceRows = data.devices.map((d) => {
    const badge = d.status !== 'active'
      ? `<span class="pill dead">${esc(d.status)}</span>`
      : d.trackingEnabled ? '<span class="pill on">tracking enabled</span>' : '<span class="pill off">paused</span>';
    const actions = d.status === 'active'
      ? `${d.trackingEnabled
            ? `<button class="warn" data-cmd="pause" data-dev="${esc(d.id)}">Pause</button>`
            : `<button data-cmd="resume" data-dev="${esc(d.id)}">Resume</button>`}
         <button class="danger" data-cmd="deactivate" data-dev="${esc(d.id)}">Deactivate</button>
         <button class="danger" data-cmd="purge" data-dev="${esc(d.id)}">Wipe &amp; purge</button>`
      : '<span class="muted small">no actions</span>';
    return `<tr>
      <td>${esc(d.hostname || d.id)}<div class="muted small">${esc(d.platform || '')} · v${esc(d.appVersion || '?')}</div></td>
      <td>${badge}</td>
      <td class="num small">${ago(d.lastSeen)}</td>
      <td class="num small">${d.consentAt ? when(d.consentAt).split(',')[0] : '<span class="muted">not recorded</span>'}</td>
      <td class="r">${actions}</td></tr>`;
  }).join('');
  app.innerHTML = chrome(`
    <div class="row"><button class="link" id="back">← Employees</button></div>
    <h1>${esc(emp.name || emp.email)}</h1>
    <p class="muted small">${esc(emp.email)} · last 30 days</p>
    <div class="grid">
      <div class="card"><h2>Tracked time</h2><div class="stat">${hm(s.totalSec)}</div><div class="muted small">${s.entryCount} sessions</div></div>
      <div class="card"><h2>Activity</h2><div class="stat">${s.activityPct == null ? '—' : s.activityPct + '%'}</div><div class="muted small">with input</div></div>
      <div class="card"><h2>Idle</h2><div class="stat">${hm(s.idleSec)}</div></div>
      <div class="card"><h2>AI-assisted</h2><div class="stat ai">${hm(s.aiSec)}</div><div class="muted small">${s.aiPct == null ? '' : s.aiPct + '% of time'}</div></div>
    </div>
    <div class="card"><h2>Devices &amp; remote management</h2>
      <table><thead><tr><th>Device</th><th>Status</th><th>Last check-in</th><th>Consent</th><th class="r">Actions</th></tr></thead>
        <tbody>${deviceRows || '<tr><td colspan="5" class="empty">No devices.</td></tr>'}</tbody></table>
      <p class="muted small" style="margin-top:12px">Pause stops data collection but keeps the agent installed. Deactivate stops the agent and unenrolls it. <b>Wipe &amp; purge</b> tells the agent to delete all tracking data it holds locally, then deactivate — use this for offboarding. Commands apply the next time the device checks in.</p>
    </div>
    <div class="cols2">
      <div class="card"><h2>AI tools used (foreground time)</h2>${barList(s.aiByTool, { ai: true })}</div>
      <div class="card"><h2>AI use by project / task</h2>${barList(s.aiByProject, { ai: true })}
        <p class="muted small">What the AI-assisted time was booked against.</p></div>
      <div class="card"><h2>AI apps seen running</h2>${barList(s.aiBackground, { ai: true, format: (n) => `${n}×` })}</div>
      <div class="card"><h2>Top applications</h2>${barList(s.apps)}</div>
      <div class="card"><h2>Time by day</h2>${barList(s.byDay)}</div>
    </div>
    <div class="card"><h2>Danger zone</h2>
      <div class="row"><span class="small muted">Permanently delete this employee's reported data from the server. This does not touch their device.</span>
      <span class="spacer"></span><button class="danger" id="deleteData">Delete server data</button></div>
    </div>`);
  wireChrome();
  document.getElementById('back').addEventListener('click', renderOverview);
  app.querySelectorAll('button[data-cmd]').forEach((b) => b.addEventListener('click', () => sendCommand(b.dataset.dev, b.dataset.cmd, id)));
  document.getElementById('deleteData').addEventListener('click', async () => {
    if (!confirm(`Permanently delete all server-side data for ${emp.email}? This cannot be undone.`)) return;
    try {
      const r = await api(`/admin/employees/${id}/data-delete`, { method: 'POST' });
      toast(`Deleted ${r.removed} entries`);
      renderEmployee(id);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

const CMD_CONFIRM = {
  purge: 'Send WIPE & PURGE to this device? When it next checks in, the agent will delete all tracking data stored on it and deactivate. Use for offboarding.',
  deactivate: 'Deactivate this device? The agent will stop tracking and unenroll at its next check-in.',
  pause: null,
  resume: null,
};

async function sendCommand(deviceId, type, empId) {
  if (CMD_CONFIRM[type] && !confirm(CMD_CONFIRM[type])) return;
  try {
    await api(`/admin/devices/${deviceId}/command`, { method: 'POST', body: { type } });
    toast(`Command "${type}" queued — applies at next check-in`);
    renderEmployee(empId);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- boot
if (token) {
  api('/admin/overview').then(renderOverview).catch(() => { token = ''; localStorage.removeItem('wt_admin_token'); renderLogin(); });
} else {
  renderLogin();
}
