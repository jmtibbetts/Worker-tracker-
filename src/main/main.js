'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, powerMonitor, desktopCapturer, screen, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { Store, DEFAULT_SETTINGS, newId } = require('./store');
const { Tracker } = require('./tracker');
const activeWindow = require('./activeWindow');
const reports = require('../shared/reports');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

let store;
let tracker;
let win = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- helpers

function send(event, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(event, payload);
  if (event === 'changed' || event === 'auto-stopped') refreshTray();
}

function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function findEntry(id) {
  const entry = store.data.entries.find((e) => e.id === id);
  if (!entry) throw new Error('Time entry not found');
  return entry;
}

function assertEditable(entry) {
  if (entry.running) throw new Error('Stop the timer before changing this entry');
  if (entry.invoiceId) throw new Error(`This entry is on invoice ${entry.invoiceNumber} and is locked. Delete the invoice to change it.`);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function screenshotPath(entryId, file) {
  // Never let a stored or supplied name escape the screenshots folder.
  return path.join(store.screenshotDir, path.basename(String(entryId)), path.basename(String(file)));
}

async function captureScreenshot(entryId) {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1600 / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const file = `${Date.now()}.jpg`;
  const target = screenshotPath(entryId, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source.thumbnail.toJPEG(60));
  return file;
}

function removeScreenshots(entry) {
  fs.rmSync(path.join(store.screenshotDir, path.basename(entry.id)), { recursive: true, force: true });
}

function publicState() {
  const d = store.data;
  return {
    settings: d.settings,
    projects: d.projects,
    invoices: d.invoices,
    running: tracker.snapshot(),
    pendingIdle: tracker.pendingIdle,
    audit: d.audit.slice(-200).reverse(),
    platform: process.platform,
    version: app.getVersion(),
    dataDir: store.dir,
    now: Date.now(),
  };
}

function withScreenshotUrls(entry) {
  if (!entry.screenshots || !entry.screenshots.length) return entry;
  return {
    ...entry,
    screenshots: entry.screenshots.map((s) => ({ ...s, url: pathToFileURL(screenshotPath(entry.id, s.file)).href })),
  };
}

// ---------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('state:get', () => publicState());

  handle('report:get', ({ from, to, projectId }) => {
    const entries = reports.filterEntries(store.data.entries, { from, to, projectId });
    return {
      entries: entries.map(withScreenshotUrls).sort((a, b) => b.start - a.start),
      summary: reports.summarize(entries, store.data.projects, store.data.settings),
    };
  });

  // ---- timer
  handle('timer:start', ({ projectId, task, notes }) => {
    if (projectId && !store.data.projects.some((p) => p.id === projectId && !p.archived)) throw new Error('Project not found');
    tracker.start({ projectId, task, notes });
    return publicState();
  });
  handle('timer:stop', () => {
    tracker.stop('user');
    return publicState();
  });
  handle('timer:idleDecision', ({ discard }) => {
    const pending = tracker.pendingIdle;
    if (pending && discard) store.audit('idle.discarded', `Discarded ${Math.round(pending.seconds / 60)} min of idle time`);
    tracker.resolveIdle(!!discard);
  });

  // ---- entries
  handle('entry:addManual', ({ projectId, task, notes, start, end }) => {
    start = num(start);
    end = num(end);
    if (!start || !end || end <= start) throw new Error('End time must be after start time');
    if (end > Date.now() + 60000) throw new Error('Manual time cannot be in the future');
    if (end - start > 24 * 3600 * 1000) throw new Error('A single entry cannot be longer than 24 hours');
    const entry = {
      id: newId(), projectId: projectId || '', task: String(task || '').trim(), notes: String(notes || '').trim(),
      start, end, running: false, manual: true, activeSec: 0, idleSec: 0, discardedSec: 0, aiSec: 0,
      apps: {}, aiTools: {}, aiBackground: [], timeline: [], screenshots: [],
    };
    store.data.entries.push(entry);
    store.audit('entry.manual', `Manual entry added: ${reports.dayKey(start)}, ${fmtClock((end - start) / 1000)} h`);
    store.save();
    send('changed');
  });

  handle('entry:update', ({ id, projectId, task, notes, start, end }) => {
    const entry = findEntry(id);
    assertEditable(entry);
    const before = `${new Date(entry.start).toISOString()} → ${new Date(entry.end).toISOString()}`;
    entry.projectId = projectId || '';
    entry.task = String(task || '').trim();
    entry.notes = String(notes || '').trim();
    if (start != null && end != null && (num(start) !== entry.start || num(end) !== entry.end)) {
      start = num(start);
      end = num(end);
      if (end <= start) throw new Error('End time must be after start time');
      if (end > Date.now() + 60000) throw new Error('Time cannot be in the future');
      entry.start = start;
      entry.end = end;
      entry.edited = true; // times no longer match what was automatically recorded
      store.audit('entry.timeEdited', `Entry ${id} times changed from ${before} to ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`);
    }
    store.save();
    send('changed');
  });

  handle('entry:delete', ({ id }) => {
    const entry = findEntry(id);
    assertEditable(entry);
    store.data.entries = store.data.entries.filter((e) => e.id !== id);
    removeScreenshots(entry);
    store.audit('entry.deleted', `Deleted ${entry.manual ? 'manual' : 'tracked'} entry from ${reports.dayKey(entry.start)} (${fmtClock(reports.entryDuration(entry))} h)`);
    store.save();
    send('changed');
  });

  handle('screenshot:delete', ({ entryId, file }) => {
    const entry = findEntry(entryId);
    entry.screenshots = (entry.screenshots || []).filter((s) => s.file !== file);
    fs.rmSync(screenshotPath(entryId, file), { force: true });
    store.audit('screenshot.deleted', `Deleted a screenshot from entry ${entryId}`);
    store.save();
    send('changed');
  });

  // ---- projects
  handle('project:save', ({ id, name, client, rate, billable, color }) => {
    name = String(name || '').trim();
    if (!name) throw new Error('Project name is required');
    const fields = {
      name,
      client: String(client || '').trim(),
      rate: rate === '' || rate == null ? null : Math.max(0, num(rate)),
      billable: billable !== false,
      color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#2563eb',
    };
    if (id) Object.assign(store.data.projects.find((p) => p.id === id) || {}, fields);
    else store.data.projects.push({ id: newId(), archived: false, ...fields });
    store.save();
    send('changed');
  });
  handle('project:setArchived', ({ id, archived }) => {
    const project = store.data.projects.find((p) => p.id === id);
    if (project) project.archived = !!archived;
    store.save();
    send('changed');
  });

  // ---- settings
  handle('settings:save', (incoming) => {
    const s = store.data.settings;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in incoming)) continue;
      const def = DEFAULT_SETTINGS[key];
      if (typeof def === 'number') s[key] = Math.max(0, num(incoming[key], def));
      else if (typeof def === 'boolean') s[key] = !!incoming[key];
      else s[key] = String(incoming[key]);
    }
    s.sampleIntervalSec = Math.min(60, Math.max(2, s.sampleIntervalSec));
    s.idleThresholdMin = Math.max(1, s.idleThresholdMin);
    s.screenshotIntervalMin = Math.max(1, s.screenshotIntervalMin);
    if (!['ask', 'discard', 'keep'].includes(s.idleAction)) s.idleAction = 'ask';
    store.audit('settings.changed', 'Settings were updated');
    store.save();
    send('changed');
  });

  // ---- exports
  handle('export:csv', async ({ from, to, projectId }) => {
    const entries = reports.filterEntries(store.data.entries, { from, to, projectId });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export timesheet',
      defaultPath: `timesheet-${reports.dayKey(from || Date.now())}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    // BOM so spreadsheet apps open the file as UTF-8.
    fs.writeFileSync(filePath, '﻿' + reports.toCsv(entries, store.data.projects, store.data.settings));
    return { saved: true, filePath };
  });
  handle('export:backup', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export all data',
      defaultPath: `worker-tracker-data-${reports.dayKey(Date.now())}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, JSON.stringify(store.data, null, 2));
    return { saved: true, filePath };
  });

  // ---- invoices
  handle('invoice:create', ({ billTo, projectIds, from, to, notes }) => {
    const s = store.data.settings;
    const ids = new Set(projectIds || []);
    const pmap = new Map(store.data.projects.map((p) => [p.id, p]));
    const entries = store.data.entries.filter(
      (e) => !e.running && !e.invoiceId && e.start >= from && e.start < to && ids.has(e.projectId || '') && reports.isBillable(pmap.get(e.projectId))
    );
    if (!entries.length) throw new Error('There is no uninvoiced billable time for that selection');
    const lines = reports.buildInvoiceLines(entries, store.data.projects, s);
    const subtotal = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
    const tax = Math.round(subtotal * (num(s.invoiceTaxPct) / 100) * 100) / 100;
    store.data.invoiceSeq += 1;
    const invoice = {
      id: newId(),
      number: `${s.invoicePrefix}${String(store.data.invoiceSeq).padStart(4, '0')}`,
      date: Date.now(), from, to,
      billTo: String(billTo || '').trim() || s.clientCompany || 'Client',
      fromName: s.contractorName, fromEmail: s.contractorEmail, fromAddress: s.contractorAddress,
      currency: s.currency, lines, subtotal, taxPct: num(s.invoiceTaxPct), tax,
      total: Math.round((subtotal + tax) * 100) / 100,
      notes: String(notes || s.invoiceTerms || ''), paid: false,
    };
    for (const e of entries) {
      e.invoiceId = invoice.id;
      e.invoiceNumber = invoice.number;
    }
    store.data.invoices.push(invoice);
    store.audit('invoice.created', `Invoice ${invoice.number} created for ${reports.money(invoice.total, invoice.currency)}`);
    store.save();
    send('changed');
    return invoice;
  });
  handle('invoice:setPaid', ({ id, paid }) => {
    const invoice = store.data.invoices.find((i) => i.id === id);
    if (invoice) invoice.paid = !!paid;
    store.save();
    send('changed');
  });
  handle('invoice:delete', ({ id }) => {
    const invoice = store.data.invoices.find((i) => i.id === id);
    if (!invoice) return;
    for (const e of store.data.entries) {
      if (e.invoiceId === id) {
        delete e.invoiceId;
        delete e.invoiceNumber;
      }
    }
    store.data.invoices = store.data.invoices.filter((i) => i.id !== id);
    store.audit('invoice.deleted', `Invoice ${invoice.number} deleted`);
    store.save();
    send('changed');
  });
  handle('invoice:pdf', async ({ id }) => {
    const invoice = store.data.invoices.find((i) => i.id === id);
    if (!invoice) throw new Error('Invoice not found');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save invoice',
      defaultPath: `${invoice.number}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { saved: false };
    const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await printer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reports.invoiceHtml(invoice)));
      fs.writeFileSync(filePath, await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
    } finally {
      printer.destroy();
    }
    shell.showItemInFolder(filePath);
    return { saved: true, filePath };
  });

  // ---- system
  handle('permissions:get', () => {
    if (process.platform !== 'darwin') return { needed: false };
    return {
      needed: true,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    };
  });
  handle('permissions:open', ({ pane }) => {
    if (process.platform !== 'darwin') return;
    const panes = { accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', automation: 'Privacy_Automation' };
    if (pane === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
    if (panes[pane]) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[pane]}`);
  });
  handle('data:openFolder', () => shell.openPath(store.dir));
}

// ---------------------------------------------------------------- window + tray

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: 'Worker Tracker',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting && tray && store.data.settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

function refreshTray() {
  if (!tray) return;
  const running = tracker.isRunning();
  const project = running ? store.data.projects.find((p) => p.id === tracker.entry.projectId) : null;
  tray.setToolTip(running ? `Worker Tracker – tracking${project ? ` ${project.name}` : ''}` : 'Worker Tracker – not tracking');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: running ? `Tracking${project ? `: ${project.name}` : ''}` : 'Not tracking', enabled: false },
      { type: 'separator' },
      running
        ? { label: 'Stop timer', click: () => tracker.stop('user') }
        : { label: 'Start timer', click: () => tracker.start({ projectId: lastProjectId() }) },
      { label: 'Open Worker Tracker', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function lastProjectId() {
  const last = [...store.data.entries].reverse().find((e) => store.data.projects.some((p) => p.id === e.projectId && !p.archived));
  return last ? last.projectId : '';
}

function createTray() {
  try {
    let image;
    if (process.platform === 'darwin') {
      image = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
      image.setTemplateImage(true);
    } else {
      image = nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 });
    }
    tray = new Tray(image);
    tray.on('click', showWindow);
    refreshTray();
  } catch (err) {
    console.error('Tray unavailable:', err.message);
    tray = null;
  }
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    const dataDir = process.env.WORKER_TRACKER_DATA_DIR || path.join(app.getPath('userData'), 'data');
    store = new Store(dataDir).load();
    tracker = new Tracker({
      store,
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      getActiveWindow: () => activeWindow.getActiveWindow({ captureUrl: store.data.settings.captureBrowserUrl }),
      listProcesses: activeWindow.listProcesses,
      captureScreenshot,
      emit: send,
    });
    registerIpc();
    createWindow();
    createTray();

    // Locking the screen or suspending stops billable time straight away.
    const pause = (why) => () => {
      if (tracker.isRunning()) {
        store.audit('timer.autostop', `Timer stopped automatically: ${why}`);
        tracker.stop(why);
      }
    };
    powerMonitor.on('lock-screen', pause('screen locked'));
    powerMonitor.on('suspend', pause('computer went to sleep'));
    powerMonitor.on('shutdown', pause('computer shut down'));

    app.on('activate', showWindow);
  });

  app.on('before-quit', () => {
    quitting = true;
    if (tracker && tracker.isRunning()) tracker.stop('app quit');
    if (store) store.saveNow();
    activeWindow.dispose();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });
}
