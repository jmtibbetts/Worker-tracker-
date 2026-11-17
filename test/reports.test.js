'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/shared/reports');

const settings = { defaultRate: 50, currency: 'USD' };
const projects = [
  { id: 'a', name: 'Website', client: 'Acme', rate: 100, billable: true },
  { id: 'b', name: 'Internal', client: '', rate: null, billable: false },
];
const t0 = new Date(2026, 0, 5, 9, 0, 0).getTime(); // a Monday
const hour = 3600 * 1000;
const entries = [
  { id: '1', projectId: 'a', start: t0, end: t0 + 2 * hour, discardedSec: 1800, activeSec: 4000, idleSec: 600, aiSec: 1350, apps: { Code: 4000 }, aiTools: { ChatGPT: 1350 }, aiBackground: ['Ollama'] },
  { id: '2', projectId: 'b', start: t0 + 3 * hour, end: t0 + 4 * hour, manual: true },
  { id: '3', projectId: '', start: t0 + 24 * hour, end: t0 + 25 * hour, activeSec: 1800, aiSec: 0, apps: { Code: 3600 } },
];

test('entryDuration subtracts discarded idle time and handles running entries', () => {
  assert.equal(r.entryDuration(entries[0]), 5400);
  assert.equal(r.entryDuration({ start: 1000, end: null, running: true }, 61000), 60);
});

test('summarize totals time, earnings, activity and AI share', () => {
  const s = r.summarize(entries, projects, settings);
  assert.equal(s.totalSec, 5400 + 3600 + 3600);
  assert.equal(s.billableSec, 5400 + 3600);
  assert.equal(s.manualSec, 3600);
  assert.equal(s.trackedSec, 9000);
  assert.equal(s.earnings, 1.5 * 100 + 1 * 50);
  assert.equal(s.aiPct, 15);
  assert.equal(s.activityPct, Math.round((5800 / 9000) * 100));
  assert.deepEqual(s.aiTools, { ChatGPT: 1350 });
  assert.deepEqual(s.aiBackground, { Ollama: 1 });
  assert.equal(s.apps.Code, 7600);
  assert.equal(Object.keys(s.byDay).length, 2);
  assert.equal(s.byProject.a.amount, 150);
});

test('filterEntries applies range and project', () => {
  assert.equal(r.filterEntries(entries, { from: t0, to: t0 + 24 * hour }).length, 2);
  assert.equal(r.filterEntries(entries, { projectId: 'a' }).length, 1);
});

test('startOfWeek returns Monday midnight', () => {
  const d = new Date(r.startOfWeek(new Date(2026, 0, 8, 15).getTime()));
  assert.equal(d.getDay(), 1);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 0);
});

test('toCsv escapes cells and neutralises formulas', () => {
  const csv = r.toCsv([{ ...entries[0], task: '=HYPERLINK("x")', notes: 'a, "b"' }], projects, settings);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[1].includes('"a, ""b"""'));
  assert.ok(lines[1].includes('ChatGPT (23m)'));
});

test('buildInvoiceLines groups by project with rounded hours', () => {
  const lines = r.buildInvoiceLines([entries[0], entries[2]], projects, settings);
  assert.deepEqual(lines.map((l) => [l.description, l.hours, l.rate, l.amount]), [['Website', 1.5, 100, 150], ['General work', 1, 50, 50]]);
});

test('invoiceHtml escapes user content', () => {
  const html = r.invoiceHtml({ number: 'INV-0001', date: t0, from: t0, to: t0 + hour, billTo: '<script>x</script>', fromName: 'Me', fromEmail: '', fromAddress: '', currency: 'USD', lines: [], subtotal: 0, taxPct: 0, tax: 0, total: 0, notes: '' });
  assert.ok(!html.includes('<script>x'));
});
