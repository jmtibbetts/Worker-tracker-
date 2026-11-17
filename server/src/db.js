'use strict';

const { DatabaseSync } = require('node:sqlite');
const { hashPassword, newToken, sha256 } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, key_hash TEXT NOT NULL,
  hostname TEXT, platform TEXT, app_version TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  tracking_enabled INTEGER NOT NULL DEFAULT 1,
  consent_at INTEGER, enrolled_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, employee_id TEXT NOT NULL,
  project TEXT, task TEXT, start INTEGER NOT NULL, end INTEGER,
  duration_sec INTEGER NOT NULL DEFAULT 0, active_sec INTEGER NOT NULL DEFAULT 0,
  idle_sec INTEGER NOT NULL DEFAULT 0, ai_sec INTEGER NOT NULL DEFAULT 0,
  apps TEXT, ai_tools TEXT, ai_background TEXT, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  issued_by TEXT, created_at INTEGER NOT NULL, acked_at INTEGER, result TEXT);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_entries_emp ON entries(employee_id, start);
CREATE INDEX IF NOT EXISTS idx_devices_emp ON devices(employee_id);
CREATE INDEX IF NOT EXISTS idx_commands_dev ON commands(device_id, status);
`;

function newId(prefix) {
  return `${prefix}_${newToken(9)}`;
}

// Coerce to a safe integer. Bitwise operators truncate to 32 bits and must never
// be used on millisecond timestamps, which exceed that range.
function int(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

class Db {
  constructor(file) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.sql.exec(SCHEMA);
  }
  close() {
    this.sql.close();
  }

  // ---- config
  getConfig(key, fallback = null) {
    const row = this.sql.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }
  setConfig(key, value) {
    this.sql.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  audit(actor, action, detail) {
    this.sql.prepare('INSERT INTO audit(ts, actor, action, detail) VALUES(?, ?, ?, ?)').run(Date.now(), actor || '', action, detail || '');
  }
  recentAudit(limit = 200) {
    return this.sql.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- admins & sessions
  createAdmin(email, password, name = '', role = 'admin') {
    const id = newId('adm');
    this.sql.prepare('INSERT INTO admins(id, email, name, pw_hash, role, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, String(email).toLowerCase(), name, hashPassword(password), role, Date.now());
    return id;
  }
  getAdminByEmail(email) {
    return this.sql.prepare('SELECT * FROM admins WHERE email = ?').get(String(email).toLowerCase());
  }
  adminCount() {
    return this.sql.prepare('SELECT COUNT(*) c FROM admins').get().c;
  }
  createSession(adminId, ttlMs = 12 * 3600 * 1000) {
    const token = newToken(32);
    const now = Date.now();
    this.sql.prepare('INSERT INTO admin_sessions(token_hash, admin_id, created_at, expires_at) VALUES(?,?,?,?)')
      .run(sha256(token), adminId, now, now + ttlMs);
    return token;
  }
  getSessionAdmin(token) {
    if (!token) return null;
    const row = this.sql.prepare(
      'SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?'
    ).get(sha256(token), Date.now());
    return row || null;
  }
  deleteSession(token) {
    this.sql.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  }

  // ---- employees & devices
  upsertEmployeeByEmail(email, name = '') {
    const e = String(email).toLowerCase();
    const existing = this.sql.prepare('SELECT * FROM employees WHERE email = ?').get(e);
    if (existing) return existing;
    const id = newId('emp');
    this.sql.prepare('INSERT INTO employees(id, email, name, status, created_at) VALUES(?,?,?,?,?)')
      .run(id, e, name, 'active', Date.now());
    return this.sql.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  }
  listEmployees() {
    return this.sql.prepare('SELECT * FROM employees ORDER BY email').all();
  }
  getEmployee(id) {
    return this.sql.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  }

  enrollDevice({ employeeId, hostname, platform, appVersion }) {
    const id = newId('dev');
    const key = newToken(32);
    const now = Date.now();
    this.sql.prepare(
      'INSERT INTO devices(id, employee_id, key_hash, hostname, platform, app_version, status, tracking_enabled, enrolled_at, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, employeeId, sha256(key), hostname || '', platform || '', appVersion || '', 'active', 1, now, now);
    return { id, key };
  }
  getDeviceByKey(key) {
    return this.sql.prepare('SELECT * FROM devices WHERE key_hash = ?').get(sha256(key));
  }
  getDevice(id) {
    return this.sql.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }
  listDevices(employeeId) {
    return this.sql.prepare('SELECT * FROM devices WHERE employee_id = ? ORDER BY enrolled_at').all(employeeId);
  }
  allDevices() {
    return this.sql.prepare('SELECT * FROM devices ORDER BY enrolled_at DESC').all();
  }
  touchDevice(id, fields = {}) {
    const sets = ['last_seen = ?'];
    const vals = [Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    this.sql.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ---- entries (idempotent on id so retried uploads do not double-count)
  saveEntry(deviceId, employeeId, e) {
    this.sql.prepare(
      `INSERT INTO entries(id, device_id, employee_id, project, task, start, end, duration_sec, active_sec, idle_sec, ai_sec, apps, ai_tools, ai_background, received_at)
       VALUES(@id,@device_id,@employee_id,@project,@task,@start,@end,@duration_sec,@active_sec,@idle_sec,@ai_sec,@apps,@ai_tools,@ai_background,@received_at)
       ON CONFLICT(id) DO UPDATE SET project=excluded.project, task=excluded.task, end=excluded.end,
         duration_sec=excluded.duration_sec, active_sec=excluded.active_sec, idle_sec=excluded.idle_sec,
         ai_sec=excluded.ai_sec, apps=excluded.apps, ai_tools=excluded.ai_tools, ai_background=excluded.ai_background`
    ).run({
      id: String(e.id), device_id: deviceId, employee_id: employeeId,
      project: e.project || '', task: e.task || '', start: int(e.start), end: int(e.end),
      duration_sec: int(e.durationSec), active_sec: int(e.activeSec), idle_sec: int(e.idleSec), ai_sec: int(e.aiSec),
      apps: JSON.stringify(e.apps || {}), ai_tools: JSON.stringify(e.aiTools || {}),
      ai_background: JSON.stringify(e.aiBackground || []), received_at: Date.now(),
    });
  }
  countEntries(deviceId) {
    return this.sql.prepare('SELECT COUNT(*) c FROM entries WHERE device_id = ?').get(deviceId).c;
  }
  clearDeviceEntries(deviceId) {
    const n = this.countEntries(deviceId);
    this.sql.prepare('DELETE FROM entries WHERE device_id = ?').run(deviceId);
    return n;
  }

  // ---- reporting
  employeeEntries(employeeId, from, to) {
    return this.sql.prepare('SELECT * FROM entries WHERE employee_id = ? AND start >= ? AND start < ? ORDER BY start DESC')
      .all(employeeId, int(from), int(to));
  }

  // ---- commands
  queueCommand(deviceId, type, payload, issuedBy) {
    const id = newId('cmd');
    this.sql.prepare('INSERT INTO commands(id, device_id, type, payload, status, issued_by, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, deviceId, type, JSON.stringify(payload || {}), 'pending', issuedBy || '', Date.now());
    return id;
  }
  pendingCommands(deviceId) {
    return this.sql.prepare("SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at").all(deviceId);
  }
  ackCommand(id, result) {
    this.sql.prepare("UPDATE commands SET status = 'acked', acked_at = ?, result = ? WHERE id = ?")
      .run(Date.now(), String(result || ''), id);
  }
  deviceCommands(deviceId, limit = 50) {
    return this.sql.prepare('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT ?').all(deviceId, limit);
  }
}

module.exports = { Db, newId };
