# Worker Tracker — Central Server

The central reporting and device-management service for the Worker Tracker agent. It:

- enrolls agent devices and issues each one a unique key;
- receives per-session summaries (time, activity, application usage, AI usage) from each
  employee's device;
- presents per-employee reports and an AI-usage breakdown in an admin console;
- lets an administrator **pause**, **deactivate**, or **wipe & purge** a device remotely
  (for leave, suspension, or offboarding);
- keeps an audit log of every administrative action.

It is a single Node.js process with no native dependencies and an embedded SQLite database
(`node:sqlite`), so it runs anywhere Node 22.5+ is available.

## Run it

```bash
cd server
npm start        # listens on http://0.0.0.0:4800
```

On first start it prints a generated **admin password** and **enrollment token** once — store
them. Configure via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4800` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `WT_SERVER_DATA_DIR` | `server/data` | Where the SQLite database is kept |
| `WT_ADMIN_EMAIL` | `admin@example.com` | Initial admin account (first run only) |
| `WT_ADMIN_PASSWORD` | random | Initial admin password (first run only) |
| `WT_ORG_NAME` | `Your Organization` | Shown to employees in the agent |

Open the printed URL, sign in, and the **Employees** page shows the enrollment token to give
to IT or type into each agent's *Settings → Managed mode*.

## Deploying for real

This server stores employee monitoring data, so treat it as sensitive:

1. **Always put it behind HTTPS.** Run it behind a reverse proxy (nginx, Caddy, a cloud load
   balancer) that terminates TLS. Device keys and admin tokens are bearer credentials sent in
   the `Authorization` header and must never travel in clear text. The agent refuses to behave
   as "managed" without a server URL and will happily use an `https://` address.
2. **Restrict network access** to the agent population and the admin team.
3. **Back up `server/data`** and restrict filesystem access to it.
4. Put a strong password on the admin account and rotate the enrollment token if it leaks
   (replace the `enrollment_token` row in the `config` table; existing devices keep working as
   they authenticate with their own keys).
5. Consider a data-retention policy and delete old data (per-employee **Delete server data**
   in the console, or a scheduled job against the `entries` table).

For a larger deployment you can point this at PostgreSQL instead of SQLite by replacing
`src/db.js` (the queries are plain SQL); the rest of the server is storage-agnostic.

## API overview

Device endpoints authenticate with `Authorization: Bearer <deviceKey>`:

| Method & path | Purpose |
| --- | --- |
| `POST /api/v1/enroll` | Exchange the enrollment token for a device key |
| `POST /api/v1/report` | Upload finished session summaries (idempotent on entry id) |
| `GET /api/v1/poll` | Fetch directives (tracking on/off) and pending commands |
| `POST /api/v1/ack` | Acknowledge executed commands |

Admin endpoints authenticate with `Authorization: Bearer <sessionToken>` from
`POST /api/v1/admin/login`:

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/admin/overview` | All employees and their status |
| `GET /api/v1/admin/employees/:id` | One employee's stats, AI breakdown, devices |
| `POST /api/v1/admin/devices/:id/command` | Queue `pause` / `resume` / `deactivate` / `purge` |
| `POST /api/v1/admin/employees/:id/data-delete` | Delete that employee's server-side data |
| `GET /api/v1/admin/audit` | Administrative audit log |

### What the device sends — and what it never sends

Each reported entry contains only **summaries**: project and task names, start/end, active,
idle and AI seconds, seconds per application, seconds per AI tool, and the names of AI apps
seen running. The agent never transmits window titles, typed text, browser addresses, or
screenshots. (Screenshots, if an administrator enables them, are stored only on the employee's
device for their own review; this server has no endpoint that receives them.)

## Remote commands

Commands are queued and delivered the next time the device checks in (within ~1 minute of
being online):

- **pause** / **resume** — stop or restart data collection; the agent stays installed and
  shows the employee a "paused by your administrator" banner.
- **deactivate** — the agent stops tracking and unenrolls.
- **purge** — the agent erases all tracking data stored locally on the device, then
  deactivates. Use this for offboarding. The server marks the device `purged` and stops
  accepting further data from it.

`purge` erases the agent's own data on that device. It does **not** touch the employee's other
files, and the server deliberately has no capability to run arbitrary code or read arbitrary
files on an enrolled machine.

## Tests

```bash
npm test
```
