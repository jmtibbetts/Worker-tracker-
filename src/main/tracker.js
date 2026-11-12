'use strict';

const { newId } = require('./store');
const { buildSignatures, detectForeground, detectProcesses } = require('../shared/aiDetector');

const BUCKET_MS = 10 * 60 * 1000; // activity timeline resolution
const SLEEP_GAP_SEC = 120; // a gap this long between samples means the computer slept
const PROCESS_SCAN_MS = 60 * 1000;
const PERSIST_MS = 30 * 1000;

/**
 * The tracking engine. While a timer is running it samples the system every
 * few seconds and aggregates the result onto the running time entry:
 * active / idle seconds, time per application, and time spent in AI tools.
 *
 * Platform access is injected so the engine can be tested without a desktop:
 *   deps.store               - Store instance
 *   deps.getIdleSeconds()    - seconds since last keyboard / mouse input
 *   deps.getActiveWindow()   - Promise<{app, title, url}|null>
 *   deps.listProcesses()     - Promise<string[]>
 *   deps.captureScreenshot(entryId) - Promise<string|null> saved file name
 *   deps.emit(event, payload)
 *   deps.now()               - optional clock override
 */
class Tracker {
  constructor(deps) {
    this.d = deps;
    this.entry = null;
    this.interval = null;
    this.busy = false;
    this.pendingIdle = null;
    this.live = { app: '', ai: null, idle: false };
  }

  now() {
    return this.d.now ? this.d.now() : Date.now();
  }

  get settings() {
    return this.d.store.data.settings;
  }

  isRunning() {
    return !!this.entry;
  }

  start({ projectId = '', task = '', notes = '' } = {}) {
    if (this.entry) this.stop('switch');
    const now = this.now();
    this.entry = {
      id: newId(),
      projectId,
      task: String(task).trim(),
      notes: String(notes).trim(),
      start: now,
      end: null,
      running: true,
      manual: false,
      lastSeen: now,
      activeSec: 0,
      idleSec: 0,
      discardedSec: 0,
      aiSec: 0,
      apps: {},
      aiTools: {},
      aiBackground: [],
      timeline: [],
      screenshots: [],
    };
    this.d.store.data.entries.push(this.entry);
    this.d.store.saveNow();

    this.signatures = buildSignatures(this.settings.customAiTools);
    this.lastTick = now;
    this.floorTs = now; // idle periods are never counted from before this point
    this.idleSince = null;
    this.idleBase = 0;
    this.lastProcessScan = 0;
    this.lastPersist = now;
    this.live = { app: '', ai: null, idle: false };
    this._scheduleScreenshot(now);

    const ms = Math.max(2, Number(this.settings.sampleIntervalSec) || 5) * 1000;
    this.interval = setInterval(() => this.tick().catch((err) => console.error('sample failed:', err)), ms);
    if (this.interval.unref) this.interval.unref();
    this.d.emit('changed');
    return this.entry;
  }

  stop(reason = 'user', endTs) {
    if (!this.entry) return null;
    clearInterval(this.interval);
    this.interval = null;
    const entry = this.entry;
    entry.end = endTs || this.now();
    entry.running = false;
    entry.stopReason = reason;
    delete entry.lastSeen;
    this.entry = null;
    this.idleSince = null;
    this.live = { app: '', ai: null, idle: false };
    this.d.store.saveNow();
    this.d.emit('changed');
    return entry;
  }

  /** Apply the user's answer to "you were idle for N minutes - keep or discard?" */
  resolveIdle(discard) {
    const pending = this.pendingIdle;
    this.pendingIdle = null;
    if (!pending || !discard) return;
    const entry = this.d.store.data.entries.find((e) => e.id === pending.entryId);
    if (entry) this._discard(entry, pending.seconds);
    this.d.store.save();
    this.d.emit('changed');
  }

  _discard(entry, seconds) {
    entry.discardedSec = (entry.discardedSec || 0) + seconds;
    entry.idleSec = Math.max(0, (entry.idleSec || 0) - seconds);
  }

  _scheduleScreenshot(now) {
    const min = Math.max(1, Number(this.settings.screenshotIntervalMin) || 10);
    // Random point in the second half of the interval so captures are not predictable.
    this.nextShotAt = now + min * 60 * 1000 * (0.5 + Math.random() * 0.5);
  }

  _bucket(now) {
    const t = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const tl = this.entry.timeline;
    let b = tl[tl.length - 1];
    if (!b || b.t !== t) {
      b = { t, total: 0, active: 0, ai: 0 };
      tl.push(b);
    }
    return b;
  }

  async tick() {
    if (!this.entry || this.busy) return;
    this.busy = true;
    try {
      await this._sample();
    } finally {
      this.busy = false;
    }
  }

  async _sample() {
    const entry = this.entry;
    const s = this.settings;
    const now = this.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (dt <= 0) return;

    // The machine was asleep (or the app was suspended): never bill that time.
    if (dt > SLEEP_GAP_SEC) {
      entry.discardedSec += dt;
      this.floorTs = now;
      this.idleSince = null;
      entry.lastSeen = now;
      this.d.store.save();
      return;
    }

    const idle = Math.max(0, Number(this.d.getIdleSeconds()) || 0);
    const threshold = Math.max(1, Number(s.idleThresholdMin) || 5) * 60;
    const bucket = this._bucket(now);
    bucket.total += dt;

    if (idle >= threshold) {
      if (this.idleSince == null) {
        this.idleSince = Math.max(this.floorTs, now - idle * 1000);
        this.idleBase = entry.idleSec;
      }
      const span = (now - this.idleSince) / 1000;
      entry.idleSec = this.idleBase + span;
      this.live = { app: '', ai: null, idle: true };

      const autoStop = Number(s.autoStopIdleMin) || 0;
      if (autoStop > 0 && span >= autoStop * 60) {
        // Nobody is here: end the entry at the moment input stopped.
        entry.idleSec = this.idleBase;
        const endTs = this.idleSince;
        this.d.store.audit('timer.autostop', `Timer stopped automatically after ${autoStop} minutes without input`);
        this.stop('idle', endTs);
        this.d.emit('auto-stopped', { minutes: autoStop });
        return;
      }
    } else {
      if (this.idleSince != null) {
        const seconds = Math.max(0, Math.round((now - this.idleSince) / 1000 - idle));
        this.idleSince = null;
        this.floorTs = now;
        if (seconds > 0) {
          if (s.idleAction === 'discard') {
            this._discard(entry, seconds);
          } else if (s.idleAction === 'ask') {
            this.pendingIdle = { entryId: entry.id, seconds };
            this.d.emit('idle-return', { seconds });
          }
        }
      }

      const hadInput = idle < dt + 1;
      if (hadInput) {
        entry.activeSec += dt;
        bucket.active += dt;
      }

      let win = null;
      try {
        win = await this.d.getActiveWindow();
      } catch {
        win = null;
      }
      if (this.entry !== entry) return; // stopped while we were waiting
      const appName = (win && win.app) || 'Unknown';
      entry.apps[appName] = (entry.apps[appName] || 0) + dt;

      let ai = null;
      if (s.detectAi) {
        ai = detectForeground(win, this.signatures);
        if (ai) {
          entry.aiSec += dt;
          entry.aiTools[ai.name] = (entry.aiTools[ai.name] || 0) + dt;
          bucket.ai += dt;
        }
      }
      this.live = { app: appName, ai: ai ? ai.name : null, idle: false };

      if (s.detectAi && now - this.lastProcessScan >= PROCESS_SCAN_MS) {
        this.lastProcessScan = now;
        try {
          const found = detectProcesses(await this.d.listProcesses(), this.signatures);
          for (const name of found) if (!entry.aiBackground.includes(name)) entry.aiBackground.push(name);
        } catch {
          /* process list unavailable - foreground detection still works */
        }
      }

      if (s.screenshotsEnabled && now >= this.nextShotAt) {
        this._scheduleScreenshot(now);
        try {
          const file = await this.d.captureScreenshot(entry.id);
          if (file && this.entry === entry) entry.screenshots.push({ file, ts: now });
        } catch (err) {
          console.error('screenshot failed:', err.message);
        }
      }
    }

    if (this.entry !== entry) return;
    entry.lastSeen = now;
    if (now - this.lastPersist >= PERSIST_MS) {
      this.lastPersist = now;
      this.d.store.save();
    }
    this.d.emit('tick', this.snapshot());
  }

  snapshot() {
    if (!this.entry) return null;
    return { entry: this.entry, live: this.live };
  }
}

module.exports = { Tracker, SLEEP_GAP_SEC };
