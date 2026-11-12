# Worker Tracker

A desktop time tracker for contractors that runs on **Windows** and **macOS**. It records
working time, activity levels, which applications were used, and **how much of the work
involved AI tools** — then turns that into timesheets and invoices.

Everything is stored on the contractor's own computer. Nothing is uploaded; data is shared by
exporting a timesheet (CSV) or an invoice (PDF).

## Features

**Time tracking**
- One-click start / stop timer with project and task, also controllable from the tray / menu bar
- Manual time entries (clearly flagged as manual) and editing of recorded entries
- Weekly hour limit with a progress meter
- Timer stops automatically when the screen is locked, the computer sleeps, or after a
  configurable period with no input
- An entry left running by a crash or power loss is closed at its last recorded moment on the
  next launch

**Activity**
- Activity level: the share of time with keyboard or mouse input (key presses themselves are
  never recorded)
- Idle detection — when you come back you choose whether to keep or discard the idle time
  (or set it to always keep / always discard)
- Time per application, per session and per period
- A 10-minute activity timeline for every session
- Optional periodic screenshots, reviewable and deletable by the contractor

**AI usage**
- Detects AI assistants, AI coding tools, local model runners and AI media / writing tools
- **Foreground time**: how long an AI tool or AI web page was the active window, broken down
  by tool
- **Background presence**: AI desktop apps and local model runners that were open during a
  session
- AI share shown per entry, per day, per project and per period, and included in exports
- Add your own tools in Settings (`Name | keyword, keyword`) — for example an internal
  assistant or a tool that is not on the built-in list

**Billing and reporting**
- Projects with client, hourly rate, colour and billable / non-billable flag
- Timesheet with period and project filters, CSV export
- Invoices built from uninvoiced billable time, with tax, numbering, paid / unpaid status and
  PDF export; invoiced entries are locked
- Change log of manual entries, edits, deletions and discarded idle time
- Full data export (JSON)

## Getting started

Requirements: [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

### Build installers

```bash
npm run dist:mac   # on a Mac: produces a .dmg and .zip in dist/
npm run dist:win   # on Windows: produces an installer .exe in dist/
```

A macOS build has to be made on a Mac and a Windows build on Windows. The included GitHub
Actions workflow (`.github/workflows/build.yml`) builds both when you push a tag such as
`v1.0.0` or run it manually from the Actions tab; the installers are attached to the run as
artifacts.

The builds are unsigned. Unsigned apps trigger a warning on first launch (Windows SmartScreen:
*More info → Run anyway*; macOS: right-click the app → *Open*). To remove the warnings, add
your own code-signing certificates to the electron-builder configuration in `package.json`.

## Permissions

**macOS** asks for these the first time they are needed (they are also listed in
*Settings → macOS permissions* inside the app):

| Permission | Why | Required? |
| --- | --- | --- |
| Accessibility | Read the title of the active window, used for AI detection in browsers | Recommended |
| Automation | Read the address of the active browser tab (more accurate AI detection) | Optional — can be turned off in Settings |
| Screen Recording | Take screenshots | Only if screenshots are enabled |

Without Accessibility the app still records time, activity and application names, and still
detects AI desktop apps; AI web pages in a browser are then only detected through the
Automation permission.

**Windows** needs no special permissions. The app runs a small background PowerShell helper
to read the foreground window.

## How AI detection works

While the timer runs, the app samples the foreground window every few seconds and compares it
against a list of known AI tools (`src/shared/aiDetector.js`) using three signals:

1. the application / process name (desktop apps),
2. the window title (browser tabs and web apps),
3. the browser tab's address (macOS, supported browsers).

Once a minute it also checks the list of running processes for AI desktop apps and local
model runners.

Limits worth knowing:

- It measures time with an AI tool **in focus**, not what was asked or produced.
- AI features embedded inside another application (for example an assistant panel inside an
  editor or office suite) are only detected when the window title reveals them.
- On Windows, detection in browsers relies on the tab title because the address is not read.
- AI used on another device is not visible.
- Detection is keyword based, so an unrelated page whose title contains a tool's name can be
  counted. Entries show which tool was matched so this can be checked.

## Privacy

- Recording only happens while the timer is running, and the app is always visible in the
  tray / menu bar. There is no hidden mode.
- Window titles and browser addresses are used in memory for AI detection and are **not**
  saved. What is saved per session: times, active / idle seconds, seconds per application,
  seconds per AI tool, and screenshots if enabled.
- Data location: `%APPDATA%\Worker Tracker\data` on Windows and
  `~/Library/Application Support/Worker Tracker/data` on macOS (*Settings → Open data folder*).

If you ask contractors to use this app, tell them what it records and check the monitoring
and consent rules that apply where they work.

## Project layout

```
src/main/main.js          app lifecycle, window, tray, IPC handlers
src/main/tracker.js       sampling engine: active / idle / applications / AI
src/main/activeWindow.js  foreground window and process list per platform
src/main/store.js         local JSON database
src/main/preload.js       bridge between UI and main process
src/shared/aiDetector.js  AI tool list and matching
src/shared/reports.js     summaries, CSV export, invoice rendering
src/renderer/             user interface
test/                     unit tests
```

## Tests

```bash
npm test
```

## Known limitations

- Single user, single computer; there is no server or team dashboard.
- Activity is based on whether input occurred in each sample, not on input counts.
- Entries are attributed to the day they start on.
- Screenshots capture the primary display only.
