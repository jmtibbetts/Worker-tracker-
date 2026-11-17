# Worker Tracker

A desktop time tracker that runs on **Windows** and **macOS**. It records working time,
activity levels, which applications were used, and **how much of the work involved AI tools** —
then turns that into timesheets and invoices.

It works in two modes:

- **Standalone** (default) — for an individual contractor. Everything stays on their own
  computer; nothing is uploaded. Data is shared by exporting a timesheet (CSV) or invoice (PDF).
- **Managed / enterprise** — the agent is enrolled with a central [server](server/) so an
  organization can collect per-employee time, activity and AI-usage reports and manage devices
  remotely (pause, deactivate, or wipe on offboarding). Managed mode is **off until a device is
  explicitly enrolled**, requires the employee to acknowledge a monitoring notice, and keeps the
  app visible the whole time it records. See [Managed mode](#managed-mode-enterprise) and, before
  you deploy it, [Legal and consent](#legal-and-consent).

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

## Managed mode (enterprise)

In managed mode each agent reports to the central [server](server/) and an administrator
manages it from a web console. Set the server up first (see [`server/README.md`](server/README.md)),
then enroll a workstation in the agent under **Settings → Managed mode** with the server
address, the employee's email, and the enrollment token from the console.

What enrollment does, by design, transparently:

- The employee sees a one-time **monitoring notice** describing exactly what is collected and
  must acknowledge it before the timer will start; the acknowledgement is recorded.
- A persistent banner shows the app is managed and names the organization and server.
- The app stays visible in the tray / menu bar whenever it records. There is **no hidden or
  stealth mode**, and the agent is a normal, uninstallable application.

What the agent sends to the server (summaries only, once a minute while enrolled):

- per session: project/task, start/end, active / idle / AI seconds, seconds per application,
  seconds per AI tool, and the names of AI apps seen running.

What it never sends: window titles, typed text or keystrokes, browser addresses, or
screenshots. (Screenshots, if enabled, stay on the employee's own device.)

What an administrator can do from the console:

- see per-employee time, activity and a full **AI-usage breakdown** (by tool and by project);
- **pause / resume** collection on a device;
- **deactivate** a device (stop and unenroll);
- **wipe & purge** a device — the agent erases all tracking data stored locally on it and then
  deactivates. Use this for firing / offboarding. This erases *the agent's own data on that
  machine*; it does not touch the employee's other files, and the server has no ability to run
  arbitrary commands on enrolled machines.

Remote commands apply the next time the device checks in (within about a minute while online).
A device that is offline keeps recording locally and syncs — and applies any pending pause or
purge — when it reconnects.

## Legal and consent

Employee monitoring is regulated, and the rules differ widely by country, state and employment
contract. Deploying the managed mode is a decision with legal weight. Before you roll it out:

- **Tell employees, in writing, before monitoring starts** what is collected, why, how long it
  is kept, and who can see it. Many jurisdictions require prior notice; several require consent,
  a legitimate-interest assessment, works-council or union consultation, or a data-protection
  impact assessment.
- **Monitor only during working hours and only for a legitimate business purpose.** This tool
  records solely while the employee runs the timer and shows them when it is active; keep it
  that way. Do not attempt to make it covert — that is both against this project's design and
  unlawful in many places.
- **Minimise and secure the data.** Run the server over HTTPS with restricted access, limit who
  can view reports, set a retention period, and delete data you no longer need (the console has
  a per-employee delete; offboarding should include a wipe & purge and a server-side delete).
- **Get advice.** Treat the above as a prompt to consult qualified legal/HR counsel for your
  jurisdictions, not as legal advice.

This software is provided to help you run a transparent program; using it in a way that
violates employees' rights or applicable law is the operator's responsibility.

## Privacy (standalone mode)

- Recording only happens while the timer is running, and the app is always visible in the
  tray / menu bar. There is no hidden mode.
- Window titles and browser addresses are used in memory for AI detection and are **not**
  saved. What is saved per session: times, active / idle seconds, seconds per application,
  seconds per AI tool, and screenshots if enabled.
- Data location: `%APPDATA%\Worker Tracker\data` on Windows and
  `~/Library/Application Support/Worker Tracker/data` on macOS (*Settings → Open data folder*).
- In managed mode, summaries are additionally sent to the server your organization configured;
  see [Managed mode](#managed-mode-enterprise) for exactly what is and is not transmitted.

## Project layout

```
src/main/main.js          app lifecycle, window, tray, IPC handlers
src/main/tracker.js       sampling engine: active / idle / applications / AI
src/main/activeWindow.js  foreground window and process list per platform
src/main/store.js         local JSON database
src/main/sync.js          managed mode: enrollment, reporting, remote commands
src/main/preload.js       bridge between UI and main process
src/shared/aiDetector.js  AI tool list and matching
src/shared/reports.js     summaries, CSV export, invoice rendering
src/renderer/             user interface
test/                     unit tests (agent + managed-mode integration)
server/                   central reporting & device-management server (see server/README.md)
```

## Tests

```bash
npm test
```

## Known limitations

- Activity is based on whether input occurred in each sample, not on input counts.
- Entries are attributed to the day they start on.
- Screenshots capture the primary display only, and are never uploaded.
- The reference server uses embedded SQLite and a single admin role; for large fleets, put it
  behind HTTPS with restricted access and consider PostgreSQL (see `server/README.md`).
- The platform window/process code (macOS AppleScript, the Windows PowerShell helper) and the
  live networked agent↔server flow are covered by automated tests but should be validated on
  real Windows and macOS hardware before a production rollout.
