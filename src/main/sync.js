'use strict';

const { entryDuration } = require('../shared/reports');

const REPORT_MS = 60 * 1000; // upload finished entries once a minute
const POLL_MS = 60 * 1000; // ask the server for directives / commands once a minute
const RETRY_MS = 15 * 1000;

/**
 * Managed-mode sync: connects an agent to a central Worker Tracker server.
 *
 * Responsibilities:
 *   - enroll the device and keep the device key in the local store
 *   - upload finished time entries (summaries only — never window titles, URLs,
 *     keystrokes or screenshots)
 *   - obey server directives: pause / resume tracking
 *   - execute remote commands: pause, resume, deactivate, purge (local wipe)
 *
 * Platform and network access are injected so this is testable without Electron:
 *   deps.store            - Store instance (local database)
 *   deps.fetch            - fetch implementation
 *   deps.emit(event, p)   - notify the rest of the app
 *   deps.onDirective(d)   - called with {trackingEnabled, status} after each contact
 *   deps.purgeLocalData() - erase all local tracking data (entries + screenshots)
 *   deps.deviceInfo()     - { hostname, platform, appVersion }
 *   deps.now()            - optional clock override
 */
class Sync {
  constructor(deps) {
    this.d = deps;
    this.timers = [];
    this.running = false;
    this.lastError = null;
    this.state = 'idle'; // idle | enrolling | online | offline | deactivated | purged
  }

  now() {
    return this.d.now ? this.d.now() : Date.now();
  }
  get cfg() {
    return this.d.store.data.managed || {};
  }
  get settings() {
    return this.d.store.data.settings;
  }

  isEnrolled() {
    return !!(this.cfg.serverUrl && this.cfg.deviceKey);
  }
  isManaged() {
    return !!(this.settings.managedMode && this.cfg.serverUrl);
  }

  _setState(state, error = null) {
    this.state = state;
    this.lastError = error;
    this.d.emit('managed-state', this.status());
  }

  status() {
    return {
      managed: this.isManaged(),
      enrolled: this.isEnrolled(),
      state: this.state,
      serverUrl: this.cfg.serverUrl || '',
      orgName: this.cfg.orgName || '',
      employeeEmail: this.cfg.employeeEmail || '',
      deviceId: this.cfg.deviceId || '',
      trackingEnabled: this.cfg.trackingEnabled !== false,
      lastSync: this.cfg.lastSync || null,
      lastError: this.lastError,
    };
  }

  async _api(path, body, { auth = true } = {}) {
    const url = this.cfg.serverUrl.replace(/\/$/, '') + path;
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = 'Bearer ' + this.cfg.deviceKey;
    const res = await this.d.fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Server error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Enroll with a one-time token entered by the employee / installer. */
  async enroll({ serverUrl, enrollmentToken, employeeEmail }) {
    serverUrl = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(serverUrl)) throw new Error('Enter a server address starting with http:// or https://');
    if (!employeeEmail) throw new Error('The employee email is required');
    this.d.store.data.managed = { serverUrl, employeeEmail: String(employeeEmail).trim().toLowerCase() };
    this._setState('enrolling');
    const info = this.d.deviceInfo();
    const data = await this._api('/api/v1/enroll', {
      enrollmentToken: String(enrollmentToken || '').trim(),
      employeeEmail: this.cfg.employeeEmail,
      hostname: info.hostname, platform: info.platform, appVersion: info.appVersion,
    }, { auth: false });
    Object.assign(this.d.store.data.managed, {
      deviceId: data.deviceId, deviceKey: data.deviceKey, employeeId: data.employeeId,
      orgName: data.orgName || '', trackingEnabled: true, enrolledAt: this.now(),
    });
    this.settings.managedMode = true;
    this.d.store.audit('managed.enrolled', `Enrolled with ${serverUrl} as ${this.cfg.employeeEmail}`);
    this.d.store.saveNow();
    this._setState('online');
    this.start();
    return this.status();
  }

  start() {
    if (this.running || !this.isManaged() || !this.isEnrolled()) return;
    this.running = true;
    const every = (fn, ms) => {
      const t = setInterval(() => fn.call(this).catch((e) => this._fail(e)), ms);
      if (t.unref) t.unref();
      this.timers.push(t);
    };
    every(this.reportOnce, REPORT_MS);
    every(this.pollOnce, POLL_MS);
    // Contact the server shortly after launch as well.
    this.reportOnce().catch((e) => this._fail(e));
    this.pollOnce().catch((e) => this._fail(e));
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  _fail(err) {
    // Network problems are transient; keep collecting locally and retry later.
    this._setState(this.state === 'deactivated' || this.state === 'purged' ? this.state : 'offline', err.message);
  }

  _applyDirective(directive) {
    if (!directive) return;
    const wasEnabled = this.cfg.trackingEnabled !== false;
    const nowEnabled = directive.trackingEnabled !== false && directive.status === 'active';
    if (wasEnabled !== nowEnabled) {
      this.cfg.trackingEnabled = nowEnabled;
      this.d.store.audit('managed.directive', `Tracking ${nowEnabled ? 'enabled' : 'paused'} by administrator`);
      this.d.store.saveNow();
    }
    this.d.onDirective({ trackingEnabled: nowEnabled, status: directive.status });
  }

  /** Entries not yet uploaded: finished, automatically tracked, and synced marker unset. */
  _unsyncedEntries() {
    return this.d.store.data.entries.filter((e) => !e.running && !e.syncedAt && e.end);
  }

  _toPayload(e) {
    return {
      id: e.id, project: this._projectName(e.projectId), task: e.task || '',
      start: e.start, end: e.end, durationSec: entryDuration(e),
      activeSec: Math.round(e.activeSec || 0), idleSec: Math.round(e.idleSec || 0), aiSec: Math.round(e.aiSec || 0),
      apps: roundValues(e.apps), aiTools: roundValues(e.aiTools), aiBackground: e.aiBackground || [],
    };
  }
  _projectName(id) {
    const p = (this.d.store.data.projects || []).find((x) => x.id === id);
    return p ? p.name : '';
  }

  async reportOnce() {
    if (!this.isEnrolled() || this.state === 'purged') return;
    const batch = this._unsyncedEntries().slice(0, 200);
    const data = await this._api('/api/v1/report', {
      appVersion: this.d.deviceInfo().appVersion,
      consentAt: this.cfg.consentAt || undefined,
      entries: batch.map((e) => this._toPayload(e)),
    });
    const now = this.now();
    for (const e of batch) e.syncedAt = now;
    this.cfg.lastSync = now;
    this.d.store.save();
    this._applyDirective(data.directives);
    if (this.state === 'offline' || this.state === 'enrolling') this._setState('online');
    return data;
  }

  async pollOnce() {
    if (!this.isEnrolled() || this.state === 'purged') return;
    const data = await this._api('/api/v1/poll');
    this._applyDirective(data.directives);
    const results = [];
    for (const cmd of data.commands || []) {
      results.push({ id: cmd.id, result: await this._execute(cmd) });
    }
    if (results.length) await this._api('/api/v1/ack', { results });
    if (this.state === 'offline') this._setState('online');
    return data;
  }

  async _execute(cmd) {
    try {
      switch (cmd.type) {
        case 'pause':
          this.cfg.trackingEnabled = false;
          this.d.onDirective({ trackingEnabled: false, status: 'active' });
          this.d.store.audit('managed.pause', 'Tracking paused by administrator');
          this.d.store.saveNow();
          return 'paused';
        case 'resume':
          this.cfg.trackingEnabled = true;
          this.d.onDirective({ trackingEnabled: true, status: 'active' });
          this.d.store.audit('managed.resume', 'Tracking resumed by administrator');
          this.d.store.saveNow();
          return 'resumed';
        case 'deactivate':
          return this._deactivate('Deactivated by administrator');
        case 'purge': {
          const removed = this.d.purgeLocalData();
          this.d.store.audit('managed.purge', `All local tracking data erased by administrator (${removed} entries)`);
          this._deactivate('Purged and deactivated by administrator', 'purged');
          return `wiped ${removed} entries, deactivated`;
        }
        default:
          return 'ignored (unknown command)';
      }
    } catch (err) {
      return 'error: ' + err.message;
    }
  }

  _deactivate(reason, finalState = 'deactivated') {
    this.d.onDirective({ trackingEnabled: false, status: finalState });
    this.cfg.trackingEnabled = false;
    this.cfg.deactivatedAt = this.now();
    this.d.store.audit('managed.deactivated', reason);
    this.d.store.saveNow();
    this.stop();
    this._setState(finalState);
    return 'done';
  }
}

function roundValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = Math.round(v);
  return out;
}

module.exports = { Sync };
