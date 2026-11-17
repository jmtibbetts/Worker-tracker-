'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { Sync } = require('../src/main/sync');
const { Db } = require('../server/src/db');
const { createApp } = require('../server/src/app');

function startServer() {
  const db = new Db(':memory:');
  db.setConfig('enrollment_token', 'TKN');
  db.setConfig('org_name', 'Acme Inc');
  db.createAdmin('a@acme.test', 'pw', 'A', 'owner');
  const server = createApp(db);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      db, server, base: `http://127.0.0.1:${server.address().port}`,
      close: () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); db.close(); },
    }));
  });
}

function makeAgent(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sync-'));
  const store = new Store(dir).load();
  store.data.projects.push({ id: 'p1', name: 'Website', client: 'Acme', rate: 100, billable: true, archived: false });
  const directives = [];
  let purged = 0;
  const sync = new Sync({
    store,
    fetch: (...a) => fetch(...a),
    emit: () => {},
    onDirective: (d) => directives.push(d),
    purgeLocalData: () => {
      const n = store.data.entries.length;
      store.data.entries = [];
      purged += n;
      store.saveNow();
      return n;
    },
    deviceInfo: () => ({ hostname: 'TEST-PC', platform: 'linux', appVersion: '1.0.0' }),
  });
  const addEntry = (id, over = {}) => {
    const e = { id, projectId: 'p1', task: 'Build', start: Date.now() - 3600e3, end: Date.now(), running: false,
      activeSec: 2800, idleSec: 200, discardedSec: 0, aiSec: 900, apps: { Code: 3000 }, aiTools: { ChatGPT: 900 }, aiBackground: ['Ollama'], ...over };
    store.data.entries.push(e);
    return e;
  };
  return { store, sync, directives, addEntry, dir, getPurged: () => purged, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('enrolls, reports entries, and the server receives the AI breakdown', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'TKN', employeeEmail: 'worker@acme.test' });
  assert.ok(a.store.data.managed.deviceKey);
  assert.equal(a.store.data.settings.managedMode, true);
  assert.equal(a.sync.status().orgName, 'Acme Inc');

  a.addEntry('e1');
  a.addEntry('e2');
  await a.sync.reportOnce();
  // Entries are marked synced so they are not re-sent.
  assert.ok(a.store.data.entries.every((e) => e.syncedAt));
  await a.sync.reportOnce();

  const emp = s.db.listEmployees()[0];
  const dev = s.db.listDevices(emp.id)[0];
  assert.equal(s.db.countEntries(dev.id), 2);
  const entries = s.db.employeeEntries(emp.id, 0, Date.now() + 1e6);
  assert.equal(JSON.parse(entries[0].ai_tools).ChatGPT, 900);
  assert.equal(entries[0].project, 'Website'); // project name resolved, not id
  a.cleanup();
  s.close();
});

test('only summaries are uploaded — no titles, urls or screenshots', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'TKN', employeeEmail: 'worker@acme.test' });
  a.addEntry('e1', { screenshots: [{ file: 'x.jpg', ts: 1 }], timeline: [{ t: 1, total: 60, active: 60, ai: 0 }] });
  const payload = a.sync._toPayload(a.store.data.entries[0]);
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'activeSec', 'aiBackground', 'aiSec', 'aiTools', 'apps', 'durationSec', 'end', 'idleSec', 'project', 'start', 'task'].sort());
  assert.ok(!('screenshots' in payload) && !('timeline' in payload));
  a.cleanup();
  s.close();
});

test('a remote pause command disables tracking on the agent', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'TKN', employeeEmail: 'worker@acme.test' });
  const dev = s.db.listDevices(s.db.listEmployees()[0].id)[0];
  s.db.queueCommand(dev.id, 'pause', {}, 'a@acme.test');

  await a.sync.pollOnce();
  assert.equal(a.store.data.managed.trackingEnabled, false);
  assert.deepEqual(a.directives.at(-1), { trackingEnabled: false, status: 'active' });
  // The command was acknowledged, so the server stops re-sending it and flips its directive.
  assert.equal(s.db.pendingCommands(dev.id).length, 0);
  assert.equal(s.db.getDevice(dev.id).tracking_enabled, 0);
  a.cleanup();
  s.close();
});

test('a remote purge erases local data and deactivates the agent', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'TKN', employeeEmail: 'worker@acme.test' });
  a.addEntry('e1');
  a.addEntry('e2');
  await a.sync.reportOnce();
  const dev = s.db.listDevices(s.db.listEmployees()[0].id)[0];
  s.db.queueCommand(dev.id, 'purge', {}, 'a@acme.test');

  await a.sync.pollOnce();
  assert.equal(a.getPurged(), 2);
  assert.equal(a.store.data.entries.length, 0);        // local data erased
  assert.equal(a.sync.state, 'purged');
  assert.equal(a.store.data.managed.trackingEnabled, false);
  assert.ok(a.directives.some((d) => d.status === 'purged'));
  // Server marks the device purged and refuses further data.
  assert.equal(s.db.getDevice(dev.id).status, 'purged');
  assert.ok(a.store.data.audit.some((x) => x.action === 'managed.purge'));
  a.cleanup();
  s.close();
});

test('enrollment refuses a bad token and leaves the agent unmanaged', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await assert.rejects(() => a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'WRONG', employeeEmail: 'w@acme.test' }), /enrollment token/i);
  assert.ok(!a.store.data.managed.deviceKey);
  a.cleanup();
  s.close();
});

test('network failure during report is non-fatal and keeps data for retry', async () => {
  const s = await startServer();
  const a = makeAgent(s.base);
  await a.sync.enroll({ serverUrl: s.base, enrollmentToken: 'TKN', employeeEmail: 'w@acme.test' });
  a.addEntry('e1');
  a.store.data.managed.serverUrl = 'http://127.0.0.1:1'; // unreachable
  await assert.rejects(() => a.sync.reportOnce());
  assert.ok(!a.store.data.entries[0].syncedAt); // not marked synced, will retry
  a.cleanup();
  s.close();
});
