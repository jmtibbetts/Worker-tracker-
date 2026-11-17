'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { Tracker } = require('../src/main/tracker');
const { entryDuration } = require('../src/shared/reports');

function setup(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  const store = new Store(dir).load();
  Object.assign(store.data.settings, settings);
  const env = { now: 1_700_000_000_000, idle: 0, win: { app: 'Code', title: 'main.js' }, procs: [], events: [], shots: 0 };
  const tracker = new Tracker({
    store,
    now: () => env.now,
    getIdleSeconds: () => env.idle,
    getActiveWindow: async () => env.win,
    listProcesses: async () => env.procs,
    captureScreenshot: async () => `shot-${++env.shots}.jpg`,
    emit: (event, payload) => env.events.push([event, payload]),
  });
  // Advance the clock by `sec` in 5 second samples.
  env.run = async (sec, change = {}) => {
    Object.assign(env, change);
    for (let i = 0; i < sec / 5; i++) {
      env.now += 5000;
      if (change.idleGrows) env.idle += 5;
      await tracker.tick();
    }
  };
  env.cleanup = () => {
    if (tracker.isRunning()) tracker.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, tracker, env };
}

test('records active time, applications and AI foreground time', async () => {
  const { tracker, env } = setup();
  const entry = tracker.start({ projectId: 'p', task: 'Build' });
  await env.run(60);
  await env.run(30, { win: { app: 'Google Chrome', title: 'Help me - ChatGPT' }, procs: ['ollama'] });
  tracker.stop();
  assert.equal(entry.running, false);
  assert.equal(entryDuration(entry), 90);
  assert.equal(entry.activeSec, 90);
  assert.deepEqual(entry.apps, { Code: 60, 'Google Chrome': 30 });
  assert.equal(entry.aiSec, 30);
  assert.deepEqual(entry.aiTools, { ChatGPT: 30 });
  assert.deepEqual(entry.aiBackground, ['Ollama']);
  assert.equal(entry.timeline.reduce((s, b) => s + b.total, 0), 90);
  env.cleanup();
});

test('AI detection can be switched off', async () => {
  const { tracker, env } = setup({ detectAi: false });
  const entry = tracker.start();
  await env.run(30, { win: { app: 'ChatGPT', title: 'ChatGPT' }, procs: ['ollama'] });
  assert.equal(entry.aiSec, 0);
  assert.deepEqual(entry.aiBackground, []);
  env.cleanup();
});

test('idle time is offered for discard when the user returns', async () => {
  const { tracker, env, store } = setup({ idleThresholdMin: 1, idleAction: 'ask', autoStopIdleMin: 0 });
  const entry = tracker.start();
  await env.run(60);
  await env.run(300, { idleGrows: true }); // walks away for 5 minutes
  assert.equal(tracker.live.idle, true);
  assert.ok(entry.idleSec >= 295);
  await env.run(5, { idle: 0, idleGrows: false }); // comes back
  const prompt = env.events.find(([name]) => name === 'idle-return');
  assert.ok(prompt, 'renderer is asked what to do with the idle time');
  assert.equal(prompt[1].seconds, 305);
  tracker.resolveIdle(true);
  tracker.stop();
  assert.equal(entry.discardedSec, 305);
  assert.equal(entryDuration(entry), 60);
  assert.equal(store.data.entries.length, 1);
  env.cleanup();
});

test('idle time is discarded automatically when configured', async () => {
  const { tracker, env } = setup({ idleThresholdMin: 1, idleAction: 'discard', autoStopIdleMin: 0 });
  const entry = tracker.start();
  await env.run(120, { idleGrows: true });
  await env.run(5, { idle: 0, idleGrows: false });
  assert.equal(entry.discardedSec, 125);
  assert.equal(tracker.pendingIdle, null);
  env.cleanup();
});

test('timer auto-stops after long inactivity and ends when input stopped', async () => {
  const { tracker, env } = setup({ idleThresholdMin: 1, autoStopIdleMin: 3 });
  const entry = tracker.start();
  const start = entry.start;
  await env.run(60);
  await env.run(600, { idleGrows: true });
  assert.equal(tracker.isRunning(), false);
  assert.equal(entry.stopReason, 'idle');
  assert.equal(entry.end, start + 60_000);
  assert.equal(entry.idleSec, 0);
  assert.ok(env.events.some(([name]) => name === 'auto-stopped'));
  env.cleanup();
});

test('time while the computer sleeps is never counted', async () => {
  const { tracker, env } = setup();
  const entry = tracker.start();
  await env.run(60);
  env.now += 3600 * 1000; // lid closed for an hour
  await tracker.tick();
  await env.run(60);
  tracker.stop();
  assert.equal(entry.discardedSec, 3600);
  assert.equal(entryDuration(entry), 120);
  env.cleanup();
});

test('screenshots are captured on schedule when enabled', async () => {
  const { tracker, env } = setup({ screenshotsEnabled: true, screenshotIntervalMin: 1 });
  const entry = tracker.start();
  await env.run(300);
  assert.ok(entry.screenshots.length >= 4 && entry.screenshots.length <= 10, `got ${entry.screenshots.length}`);
  env.cleanup();
});

test('an entry left running by a crash is closed on next launch', async () => {
  const { tracker, env, store } = setup();
  tracker.start();
  await env.run(60);
  store.saveNow(); // simulate the process dying here, timer still running
  clearInterval(tracker.interval);
  const reopened = new Store(store.dir).load();
  const entry = reopened.data.entries[0];
  assert.equal(entry.running, false);
  assert.equal(entry.recovered, true);
  assert.equal(entryDuration(entry), 60);
  tracker.entry = null;
  env.cleanup();
});
