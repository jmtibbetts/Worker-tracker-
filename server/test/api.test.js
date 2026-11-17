'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Db } = require('../src/db');
const { createApp, summarize } = require('../src/app');

function startServer() {
  const db = new Db(':memory:');
  db.setConfig('enrollment_token', 'ENROLL-TOKEN');
  db.setConfig('org_name', 'Acme Inc');
  db.createAdmin('admin@acme.test', 'hunter2!', 'Boss', 'owner');
  const server = createApp(db);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ db, server, base, close: () => { server.closeAllConnections && server.closeAllConnections(); server.close(); db.close(); } });
    });
  });
}

async function req(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sampleEntry = (id, over = {}) => ({
  id, project: 'Website', task: 'Build', start: Date.UTC(2026, 0, 5, 9), end: Date.UTC(2026, 0, 5, 11),
  durationSec: 7200, activeSec: 6000, idleSec: 600, aiSec: 1800,
  apps: { Code: 5000, 'Google Chrome': 2200 }, aiTools: { ChatGPT: 1200, 'GitHub Copilot': 600 }, aiBackground: ['Ollama'], ...over,
});

test('enrollment requires the correct token', async () => {
  const s = await startServer();
  const bad = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'nope', employeeEmail: 'e@acme.test' } });
  assert.equal(bad.status, 401);
  const ok = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'Worker@Acme.test', hostname: 'LAPTOP-1', platform: 'win32' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.deviceKey && ok.body.deviceId.startsWith('dev_'));
  assert.equal(ok.body.orgName, 'Acme Inc');
  s.close();
});

test('a device reports entries and they are stored once (idempotent)', async () => {
  const s = await startServer();
  const e = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'w@acme.test' } });
  const key = e.body.deviceKey;
  const r1 = await req(s.base, '/api/v1/report', { method: 'POST', token: key, body: { entries: [sampleEntry('a1'), sampleEntry('a2')], consentAt: 123 } });
  assert.equal(r1.body.accepted, 2);
  assert.equal(r1.body.directives.trackingEnabled, true);
  // Re-sending the same ids must not double-count.
  const r2 = await req(s.base, '/api/v1/report', { method: 'POST', token: key, body: { entries: [sampleEntry('a1', { aiSec: 999 })] } });
  assert.equal(r2.body.accepted, 1);
  assert.equal(s.db.countEntries(e.body.deviceId), 2);
  s.close();
});

test('reporting is rejected without a valid device key', async () => {
  const s = await startServer();
  const r = await req(s.base, '/api/v1/report', { method: 'POST', token: 'garbage', body: { entries: [sampleEntry('x')] } });
  assert.equal(r.status, 401);
  s.close();
});

test('admin login, overview and per-employee AI breakdown', async () => {
  const s = await startServer();
  const e = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'w@acme.test', hostname: 'PC' } });
  await req(s.base, '/api/v1/report', { method: 'POST', token: e.body.deviceKey, body: { entries: [sampleEntry('a1')] } });

  assert.equal((await req(s.base, '/api/v1/admin/overview')).status, 401);
  const login = await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'wrong' } });
  assert.equal(login.status, 401);
  const good = await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'hunter2!' } });
  const token = good.body.token;
  assert.ok(token);

  const overview = await req(s.base, '/api/v1/admin/overview', { token });
  assert.equal(overview.body.employees.length, 1);
  assert.equal(overview.body.employees[0].email, 'w@acme.test');

  const detail = await req(s.base, `/api/v1/admin/employees/${e.body.employeeId}?from=0&to=99999999999999`, { token });
  assert.equal(detail.body.summary.totalSec, 7200);
  assert.equal(detail.body.summary.aiSec, 1800);
  assert.deepEqual(detail.body.summary.aiByTool, { ChatGPT: 1200, 'GitHub Copilot': 600 });
  assert.deepEqual(detail.body.summary.aiByProject, { Website: 1800 });
  assert.deepEqual(detail.body.summary.aiBackground, { Ollama: 1 });
  assert.equal(detail.body.devices[0].hostname, 'PC');
  s.close();
});

test('admin can pause and resume a device via commands', async () => {
  const s = await startServer();
  const e = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'w@acme.test' } });
  const key = e.body.deviceKey;
  const token = (await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'hunter2!' } })).body.token;

  await req(s.base, `/api/v1/admin/devices/${e.body.deviceId}/command`, { method: 'POST', token, body: { type: 'pause' } });
  const poll = await req(s.base, '/api/v1/poll', { token: key });
  assert.equal(poll.body.commands.length, 1);
  assert.equal(poll.body.commands[0].type, 'pause');

  // Agent acknowledges; tracking is then disabled in directives.
  await req(s.base, '/api/v1/ack', { method: 'POST', token: key, body: { results: [{ id: poll.body.commands[0].id, result: 'paused' }] } });
  const after = await req(s.base, '/api/v1/poll', { token: key });
  assert.equal(after.body.directives.trackingEnabled, false);
  assert.equal(after.body.commands.length, 0);

  // Resume flips it back on.
  await req(s.base, `/api/v1/admin/devices/${e.body.deviceId}/command`, { method: 'POST', token, body: { type: 'resume' } });
  const p2 = await req(s.base, '/api/v1/poll', { token: key });
  await req(s.base, '/api/v1/ack', { method: 'POST', token: key, body: { results: [{ id: p2.body.commands[0].id, result: 'resumed' }] } });
  assert.equal((await req(s.base, '/api/v1/poll', { token: key })).body.directives.trackingEnabled, true);
  s.close();
});

test('purge command deactivates the device and stops accepting data', async () => {
  const s = await startServer();
  const e = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'w@acme.test' } });
  const key = e.body.deviceKey;
  await req(s.base, '/api/v1/report', { method: 'POST', token: key, body: { entries: [sampleEntry('a1')] } });
  const token = (await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'hunter2!' } })).body.token;

  await req(s.base, `/api/v1/admin/devices/${e.body.deviceId}/command`, { method: 'POST', token, body: { type: 'purge' } });
  const poll = await req(s.base, '/api/v1/poll', { token: key });
  assert.equal(poll.body.commands[0].type, 'purge');
  await req(s.base, '/api/v1/ack', { method: 'POST', token: key, body: { results: [{ id: poll.body.commands[0].id, result: 'wiped 1 entry, deactivated' }] } });

  const dev = s.db.getDevice(e.body.deviceId);
  assert.equal(dev.status, 'purged');
  // Further reports are refused (no new data accepted) and the device is told it is inactive.
  const late = await req(s.base, '/api/v1/report', { method: 'POST', token: key, body: { entries: [sampleEntry('a2')] } });
  assert.equal(late.body.accepted, 0);
  assert.equal(late.body.directives.trackingEnabled, false);
  assert.equal(late.body.directives.status, 'purged');
  s.close();
});

test('admin can delete an employee\'s server-side data', async () => {
  const s = await startServer();
  const e = await req(s.base, '/api/v1/enroll', { method: 'POST', body: { enrollmentToken: 'ENROLL-TOKEN', employeeEmail: 'w@acme.test' } });
  await req(s.base, '/api/v1/report', { method: 'POST', token: e.body.deviceKey, body: { entries: [sampleEntry('a1'), sampleEntry('a2')] } });
  const token = (await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'hunter2!' } })).body.token;
  const del = await req(s.base, `/api/v1/admin/employees/${e.body.employeeId}/data-delete`, { method: 'POST', token });
  assert.equal(del.body.removed, 2);
  assert.equal(s.db.countEntries(e.body.deviceId), 0);
  s.close();
});

test('summarize aggregates activity and AI correctly', () => {
  const rows = [
    { duration_sec: 3600, active_sec: 3000, idle_sec: 300, ai_sec: 900, start: Date.UTC(2026, 0, 5), project: 'A', task: '', ai_tools: '{"ChatGPT":900}', apps: '{"Code":3000}', ai_background: '["Ollama"]' },
    { duration_sec: 1800, active_sec: 1500, idle_sec: 0, ai_sec: 0, start: Date.UTC(2026, 0, 6), project: 'B', task: '', ai_tools: '{}', apps: '{"Slack":1800}', ai_background: '[]' },
  ];
  const s = summarize(rows);
  assert.equal(s.totalSec, 5400);
  assert.equal(s.aiSec, 900);
  assert.equal(s.aiPct, 17);
  assert.equal(s.activityPct, Math.round((4500 / 5400) * 100));
  assert.deepEqual(s.aiByProject, { A: 900 });
  assert.equal(Object.keys(s.byDay).length, 2);
});

test('unknown admin endpoints 404 and bad JSON 400', async () => {
  const s = await startServer();
  const token = (await req(s.base, '/api/v1/admin/login', { method: 'POST', body: { email: 'admin@acme.test', password: 'hunter2!' } })).body.token;
  assert.equal((await req(s.base, '/api/v1/admin/nope', { token })).status, 404);
  const res = await fetch(s.base + '/api/v1/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  s.close();
});
