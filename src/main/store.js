'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  contractorName: '',
  contractorEmail: '',
  contractorAddress: '',
  clientCompany: '',
  currency: 'USD',
  defaultRate: 50,
  weeklyHourLimit: 40,
  sampleIntervalSec: 5,
  idleThresholdMin: 5,
  idleAction: 'ask', // 'ask' | 'discard' | 'keep'
  autoStopIdleMin: 30, // 0 disables
  detectAi: true,
  captureBrowserUrl: true,
  screenshotsEnabled: false,
  screenshotIntervalMin: 10,
  customAiTools: '', // one per line: "Name | keyword, keyword"
  invoicePrefix: 'INV-',
  invoiceTaxPct: 0,
  invoiceTerms: 'Payment due within 30 days.',
  minimizeToTray: true,
  // Managed (enterprise) mode. Off until a device is enrolled with a server.
  managedMode: false,
  consentAt: 0,
};

function emptyDb() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    projects: [],
    entries: [],
    invoices: [],
    invoiceSeq: 0,
    audit: [],
    managed: {}, // enterprise enrollment: serverUrl, deviceId, deviceKey, employeeEmail, ...
  };
}

/**
 * Small JSON-file database. All data stays on the local machine.
 * Writes are debounced and atomic (write to temp file, then rename).
 */
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.screenshotDir = path.join(dir, 'screenshots');
    this.data = emptyDb();
    this._timer = null;
  }

  load() {
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    for (const candidate of [this.file, this.file + '.bak']) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        this.data = { ...emptyDb(), ...parsed };
        this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Could not read ${candidate}:`, err.message);
      }
    }
    this._recoverInterrupted();
    return this;
  }

  /** Close any entry left running by a crash or forced shutdown. */
  _recoverInterrupted() {
    let changed = false;
    for (const e of this.data.entries) {
      if (e.running) {
        e.running = false;
        e.end = e.lastSeen || e.start;
        e.recovered = true;
        changed = true;
        this.audit('entry.recovered', `Timer for entry ${e.id} was closed after an unexpected shutdown`);
      }
    }
    if (changed) this.saveNow();
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
  }

  audit(action, detail) {
    this.data.audit.push({ ts: Date.now(), action, detail });
    if (this.data.audit.length > 5000) this.data.audit.splice(0, this.data.audit.length - 5000);
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { Store, DEFAULT_SETTINGS, newId };
