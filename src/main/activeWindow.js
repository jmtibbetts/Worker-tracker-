'use strict';

const { execFile, spawn } = require('child_process');

/**
 * Foreground-window lookup with no native add-ons, so the app builds the same
 * way on every platform:
 *   macOS   - AppleScript via osascript (needs Accessibility permission for titles)
 *   Windows - one long-lived PowerShell helper calling user32.dll
 *   Linux   - xdotool when installed (development convenience only)
 */

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

// ---------------------------------------------------------------- macOS

const MAC_WINDOW_SCRIPT = `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc
  set winTitle to ""
  try
    set winTitle to name of front window of frontProc
  end try
end tell
return appName & linefeed & winTitle`;

const MAC_CHROMIUM_BROWSERS = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Vivaldi', 'Opera'];
const MAC_SAFARI_BROWSERS = ['Safari', 'Safari Technology Preview'];

async function macActiveWindow({ captureUrl }) {
  const out = await run('osascript', ['-e', MAC_WINDOW_SCRIPT]);
  if (out == null) return null;
  const [app = '', ...rest] = out.replace(/\n$/, '').split('\n');
  const win = { app: app.trim(), title: rest.join(' ').trim(), url: '' };
  if (captureUrl) {
    let script = null;
    if (MAC_CHROMIUM_BROWSERS.includes(win.app)) script = `tell application "${win.app}" to return URL of active tab of front window`;
    else if (MAC_SAFARI_BROWSERS.includes(win.app)) script = `tell application "${win.app}" to return URL of front document`;
    if (script) {
      const url = await run('osascript', ['-e', script], 2500);
      if (url) win.url = url.trim();
    }
  }
  return win;
}

async function macProcesses() {
  const out = await run('ps', ['-axo', 'comm=']);
  if (!out) return [];
  return out.split('\n').map((line) => line.trim().split('/').pop()).filter(Boolean);
}

// ---------------------------------------------------------------- Windows

const WIN_HELPER = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WtForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $handle = [WtForeground]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [void][WtForeground]::GetWindowText($handle, $sb, 1024)
  $procId = [uint32]0
  [void][WtForeground]::GetWindowThreadProcessId($handle, [ref]$procId)
  $name = ''
  $desc = ''
  $proc = Get-Process -Id $procId
  if ($proc) {
    $name = $proc.ProcessName
    $desc = $proc.MainModule.FileVersionInfo.FileDescription
  }
  $result = @{ process = $name; description = $desc; title = $sb.ToString() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($result)
}`;

class WindowsHelper {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.waiting = [];
  }

  _ensure() {
    if (this.proc) return;
    const encoded = Buffer.from(WIN_HELPER, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        const waiter = this.waiting.shift();
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(JSON.parse(line));
        } catch {
          waiter.resolve(null);
        }
      }
    });
    const reset = () => {
      this.proc = null;
      this.buffer = '';
      for (const w of this.waiting.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    };
    this.proc.on('error', reset);
    this.proc.on('exit', reset);
    this.proc.stdin.on('error', () => {});
  }

  query() {
    this._ensure();
    return new Promise((resolve) => {
      // The first request also waits for PowerShell to start and compile the helper.
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(null);
        // A late reply would pair with the wrong request, so restart the helper.
        this.dispose();
      }, 15000);
      this.waiting.push(waiter);
      try {
        this.proc.stdin.write('q\n');
      } catch {
        /* handled by the exit/error listeners */
      }
    });
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

const winHelper = new WindowsHelper();

async function winActiveWindow() {
  const res = await winHelper.query();
  if (!res) return null;
  const processName = res.process || '';
  // Prefer the friendly product name ("Google Chrome") and keep the executable name for matching.
  return { app: (res.description || '').trim() || processName, process: processName, title: res.title || '', url: '' };
}

async function winProcesses() {
  const out = await run('tasklist', ['/fo', 'csv', '/nh'], 8000);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => {
      const m = /^"([^"]+)"/.exec(line);
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------- Linux (dev only)

async function linuxActiveWindow() {
  const title = await run('xdotool', ['getactivewindow', 'getwindowname'], 2000);
  if (title == null) return null;
  const pid = await run('xdotool', ['getactivewindow', 'getwindowpid'], 2000);
  let app = '';
  if (pid) app = ((await run('ps', ['-p', pid.trim(), '-o', 'comm='])) || '').trim();
  return { app, title: title.trim(), url: '' };
}

async function linuxProcesses() {
  const out = await run('ps', ['-eo', 'comm=']);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------- public API

function getActiveWindow(options = {}) {
  if (process.platform === 'darwin') return macActiveWindow(options);
  if (process.platform === 'win32') return winActiveWindow();
  return linuxActiveWindow();
}

function listProcesses() {
  if (process.platform === 'darwin') return macProcesses();
  if (process.platform === 'win32') return winProcesses();
  return linuxProcesses();
}

function dispose() {
  winHelper.dispose();
}

module.exports = { getActiveWindow, listProcesses, dispose };
