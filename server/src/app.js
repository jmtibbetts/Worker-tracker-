'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { verifyPassword } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMMAND_TYPES = new Set(['pause', 'resume', 'purge', 'deactivate']);
const MAX_BODY = 4 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// Derived per-employee / per-device statistics, including the AI breakdown.
function summarize(entries) {
  const s = {
    entryCount: entries.length, totalSec: 0, activeSec: 0, idleSec: 0, aiSec: 0,
    aiByTool: {}, aiByProject: {}, apps: {}, aiBackground: {}, byDay: {},
  };
  const add = (obj, k, v) => { obj[k] = (obj[k] || 0) + v; };
  for (const e of entries) {
    s.totalSec += e.duration_sec;
    s.activeSec += e.active_sec;
    s.idleSec += e.idle_sec;
    s.aiSec += e.ai_sec;
    const day = new Date(e.start).toISOString().slice(0, 10);
    add(s.byDay, day, e.duration_sec);
    const label = e.project || e.task || 'Unassigned';
    if (e.ai_sec) add(s.aiByProject, label, e.ai_sec);
    for (const [tool, sec] of Object.entries(JSON.parse(e.ai_tools || '{}'))) add(s.aiByTool, tool, sec);
    for (const [app, sec] of Object.entries(JSON.parse(e.apps || '{}'))) add(s.apps, app, sec);
    for (const tool of JSON.parse(e.ai_background || '[]')) add(s.aiBackground, tool, 1);
  }
  s.activityPct = s.totalSec ? Math.round((s.activeSec / s.totalSec) * 100) : null;
  s.aiPct = s.totalSec ? Math.round((s.aiSec / s.totalSec) * 100) : null;
  return s;
}

function createApp(db, options = {}) {
  const log = options.log || (() => {});

  // ---- device (agent) endpoints -----------------------------------------
  async function enroll(req, res) {
    const body = await readJson(req);
    const token = String(body.enrollmentToken || '');
    const expected = db.getConfig('enrollment_token');
    if (!expected || token !== expected) return send(res, 401, { error: 'Invalid enrollment token' });
    if (!body.employeeEmail) return send(res, 400, { error: 'employeeEmail is required' });
    const employee = db.upsertEmployeeByEmail(body.employeeEmail, body.employeeName || '');
    if (employee.status !== 'active') return send(res, 403, { error: 'This employee account is not active' });
    const device = db.enrollDevice({
      employeeId: employee.id, hostname: body.hostname, platform: body.platform, appVersion: body.appVersion,
    });
    db.audit(body.employeeEmail, 'device.enrolled', `${body.hostname || 'device'} (${body.platform || '?'}) enrolled from ${clientIp(req)}`);
    log('enroll', employee.email, device.id);
    // The device key is returned exactly once; only its hash is stored.
    return send(res, 200, {
      deviceId: device.id, deviceKey: device.key, employeeId: employee.id,
      orgName: db.getConfig('org_name', 'Your Organization'),
    });
  }

  function authDevice(req, res) {
    const key = bearer(req);
    const device = key && db.getDeviceByKey(key);
    if (!device) {
      send(res, 401, { error: 'Unknown or revoked device' });
      return null;
    }
    return device;
  }

  // The directives the agent must obey on every check-in.
  function directivesFor(device) {
    return {
      status: device.status,
      trackingEnabled: device.status === 'active' && !!device.tracking_enabled,
      serverTime: Date.now(),
    };
  }

  async function report(req, res) {
    const device = authDevice(req, res);
    if (!device) return;
    const body = await readJson(req);
    // A deactivated/purged device may still call in; we accept nothing and tell it to stop.
    if (device.status !== 'active') {
      db.touchDevice(device.id, { app_version: body.appVersion || device.app_version });
      return send(res, 200, { accepted: 0, directives: directivesFor(device) });
    }
    let accepted = 0;
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 1000) : [];
    for (const e of entries) {
      if (!e || !e.id || !e.start) continue;
      db.saveEntry(device.id, device.employee_id, e);
      accepted++;
    }
    const patch = { app_version: body.appVersion || device.app_version };
    if (body.consentAt && !device.consent_at) patch.consent_at = Math.trunc(Number(body.consentAt)) || null;
    db.touchDevice(device.id, patch);
    log('report', device.id, accepted);
    return send(res, 200, { accepted, directives: directivesFor(db.getDevice(device.id)) });
  }

  async function poll(req, res) {
    const device = authDevice(req, res);
    if (!device) return;
    db.touchDevice(device.id, {});
    const commands = db.pendingCommands(device.id).map((c) => ({ id: c.id, type: c.type, payload: JSON.parse(c.payload || '{}') }));
    return send(res, 200, { directives: directivesFor(device), commands });
  }

  async function ack(req, res) {
    const device = authDevice(req, res);
    if (!device) return;
    const body = await readJson(req);
    for (const item of Array.isArray(body.results) ? body.results : []) {
      const cmd = db.pendingCommands(device.id).find((c) => c.id === item.id);
      if (!cmd) continue;
      db.ackCommand(cmd.id, item.result || 'done');
      if (cmd.type === 'pause') db.touchDevice(device.id, { tracking_enabled: 0 });
      if (cmd.type === 'resume') db.touchDevice(device.id, { tracking_enabled: 1 });
      if (cmd.type === 'deactivate') db.touchDevice(device.id, { status: 'deactivated', tracking_enabled: 0 });
      if (cmd.type === 'purge') db.touchDevice(device.id, { status: 'purged', tracking_enabled: 0 });
      db.audit(device.employee_id, `command.${cmd.type}.acked`, `Device ${device.id}: ${item.result || 'done'}`);
      log('ack', device.id, cmd.type);
    }
    return send(res, 200, { ok: true, directives: directivesFor(db.getDevice(device.id)) });
  }

  // ---- admin endpoints ---------------------------------------------------
  async function adminLogin(req, res) {
    const body = await readJson(req);
    const admin = db.getAdminByEmail(body.email || '');
    if (!admin || !verifyPassword(body.password || '', admin.pw_hash)) {
      db.audit(body.email || '', 'admin.login.failed', clientIp(req));
      return send(res, 401, { error: 'Incorrect email or password' });
    }
    const token = db.createSession(admin.id);
    db.audit(admin.email, 'admin.login', clientIp(req));
    return send(res, 200, { token, admin: { email: admin.email, name: admin.name, role: admin.role } });
  }

  function authAdmin(req, res) {
    const admin = db.getSessionAdmin(bearer(req));
    if (!admin) {
      send(res, 401, { error: 'Not signed in' });
      return null;
    }
    return admin;
  }

  function deviceView(d) {
    return {
      id: d.id, hostname: d.hostname, platform: d.platform, appVersion: d.app_version,
      status: d.status, trackingEnabled: !!d.tracking_enabled, lastSeen: d.last_seen,
      enrolledAt: d.enrolled_at, consentAt: d.consent_at, entryCount: db.countEntries(d.id),
    };
  }

  const handlers = {
    'GET /api/v1/admin/overview': (req, res, admin) => {
      const employees = db.listEmployees().map((e) => {
        const devices = db.listDevices(e.id);
        return {
          id: e.id, email: e.email, name: e.name, status: e.status,
          devices: devices.length,
          lastSeen: devices.reduce((m, d) => Math.max(m, d.last_seen || 0), 0) || null,
          tracking: devices.some((d) => d.status === 'active' && d.tracking_enabled),
        };
      });
      send(res, 200, { orgName: db.getConfig('org_name', 'Your Organization'), you: { email: admin.email }, employees });
    },
    'GET /api/v1/admin/enrollment': (req, res) => send(res, 200, {
      enrollmentToken: db.getConfig('enrollment_token'), orgName: db.getConfig('org_name', 'Your Organization'),
    }),
    'GET /api/v1/admin/audit': (req, res) => send(res, 200, { audit: db.recentAudit(200) }),
  };

  async function adminEmployee(req, res, admin, id, url) {
    const employee = db.getEmployee(id);
    if (!employee) return send(res, 404, { error: 'Employee not found' });
    const qnum = (key, fallback) => {
      const raw = url.searchParams.get(key);
      if (raw == null || raw === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    const to = qnum('to', Date.now());
    const from = qnum('from', to - 30 * 24 * 3600 * 1000);
    const entries = db.employeeEntries(employee.id, from, to);
    send(res, 200, {
      employee: { id: employee.id, email: employee.email, name: employee.name, status: employee.status },
      devices: db.listDevices(employee.id).map(deviceView),
      range: { from, to },
      summary: summarize(entries),
      entries: entries.slice(0, 500).map((e) => ({
        id: e.id, project: e.project, task: e.task, start: e.start, end: e.end,
        durationSec: e.duration_sec, activeSec: e.active_sec, idleSec: e.idle_sec, aiSec: e.ai_sec,
        aiTools: JSON.parse(e.ai_tools || '{}'), apps: JSON.parse(e.apps || '{}'),
        aiBackground: JSON.parse(e.ai_background || '[]'),
      })),
    });
  }

  async function adminCommand(req, res, admin, deviceId) {
    const device = db.getDevice(deviceId);
    if (!device) return send(res, 404, { error: 'Device not found' });
    const body = await readJson(req);
    const type = String(body.type || '');
    if (!COMMAND_TYPES.has(type)) return send(res, 400, { error: `Unknown command: ${type}` });
    const id = db.queueCommand(device.id, type, body.payload, admin.email);
    db.audit(admin.email, `command.${type}.issued`, `Device ${device.id} (${device.hostname || '?'})`);
    log('command', admin.email, type, device.id);
    send(res, 200, { ok: true, commandId: id, queued: type });
  }

  // Server-side data removal (separate from the on-device purge command).
  async function adminDeleteData(req, res, admin, employeeId) {
    const employee = db.getEmployee(employeeId);
    if (!employee) return send(res, 404, { error: 'Employee not found' });
    let removed = 0;
    for (const d of db.listDevices(employee.id)) removed += db.clearDeviceEntries(d.id);
    db.audit(admin.email, 'data.deleted', `Removed ${removed} entries for ${employee.email} from the server`);
    send(res, 200, { ok: true, removed });
  }

  async function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(file);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      // Device endpoints
      if (route === 'POST /api/v1/enroll') return await enroll(req, res);
      if (route === 'POST /api/v1/report') return await report(req, res);
      if (route === 'GET /api/v1/poll') return await poll(req, res);
      if (route === 'POST /api/v1/ack') return await ack(req, res);
      if (route === 'POST /api/v1/admin/login') return await adminLogin(req, res);
      if (route === 'GET /healthz') return send(res, 200, { ok: true });

      // Admin endpoints (auth required)
      if (url.pathname.startsWith('/api/v1/admin/')) {
        const admin = authAdmin(req, res);
        if (!admin) return;
        if (route === 'POST /api/v1/admin/logout') {
          db.deleteSession(bearer(req));
          return send(res, 200, { ok: true });
        }
        if (handlers[route]) return handlers[route](req, res, admin);
        let m;
        if ((m = /^GET \/api\/v1\/admin\/employees\/([^/]+)$/.exec(route))) return await adminEmployee(req, res, admin, m[1], url);
        if ((m = /^POST \/api\/v1\/admin\/employees\/([^/]+)\/data-delete$/.exec(route))) return await adminDeleteData(req, res, admin, m[1]);
        if ((m = /^POST \/api\/v1\/admin\/devices\/([^/]+)\/command$/.exec(route))) return await adminCommand(req, res, admin, m[1]);
        return send(res, 404, { error: 'Unknown endpoint' });
      }

      if (req.method === 'GET') return await serveStatic(req, res, url);
      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (err) {
      return send(res, 400, { error: err.message || 'Bad request' });
    }
  });

  return server;
}

module.exports = { createApp, summarize };
