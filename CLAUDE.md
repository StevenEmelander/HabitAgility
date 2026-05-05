# Good Habit Tracker — maintainer notes

Reference for humans and coding agents working in this repository.

## What this is

A self-contained **single-file** web app (`app/tracker.html`) plus a small **AWS CDK** stack. Intended for **personal** hosting: obscure hostname, Lambda@Edge cookie gate, optional unlock query parameter for new devices.

## Critical constraints (read before editing)

1. **Single-file HTML only** (`app/tracker.html`). Inline CSS/JS. No external CSS, frameworks, or CDN dependencies for the app shell.

2. **Cloud is the source of truth.** No `localStorage` for tracker payload. The API is per-item REST under `/api/*`, gated by the CloudFront `X-CF-Secret` header (the lambda rejects anything missing it).

   **Routes:**
   - `GET /api/cycles` → `{ cycles: [...], entryBounds: { min, max } }` — one DDB `GetItem` on the cycles row.
   - `GET /api/cycles/:cycleId` → one cycle object or 404.
   - `PUT /api/cycles/:cycleId` body `{ startDate, endDate, lengthDays, categories, habitDefinitions }` → `{ ok, removedHabitIds }`. Server reads the cycles row, replaces the named cycle, writes it back, then sweeps any habit ids no cycle defines anymore from every entry row. The returned `removedHabitIds` lets the front-end mirror that sweep locally without a second fetch.
   - `DELETE /api/cycles/:cycleId` → same shape; sweeps orphans.
   - `GET /api/entries` → `{ entries: { dateKey: habitValuesById } }` — one paginated `Query pk='DAY'` (no SK condition; partition-targeted, never a Scan).
   - `GET /api/entries/:dateKey` → one entry or 404.
   - `PUT /api/entries/:dateKey` body `{ habitValuesById }` → `{ ok }`. If `habitValuesById` is empty, the row is deleted instead. Bounds (`entryDateMin`/`entryDateMax` on the cycles row) are bumped via conditional `UpdateItem` only when the new date extends them.
   - `DELETE /api/entries/:dateKey` → `{ ok }`. Recomputes bounds via two `Query Limit:1` reads (asc/desc) only when the deleted date was a current bound.

   **Boot** is two parallel calls — `GET /api/cycles` + `GET /api/entries`. No date-range parameters anywhere. **Edits** debounce per item: `pushCycle(id)` and `pushEntry(date)` each at 1500ms, keyed by id/date so concurrent edits to different items don't collide.

   **DynamoDB tables:**
   - `good-habit-tracker-cycles` — one row, `id="main"`, attrs `cyclesJson`, `entryDateMin`, `entryDateMax`, `updatedAt`. (The physical table name keeps `cycles` in it; the row holds both the cycle definitions and the entry-date bounds.)
   - `good-habit-tracker-day-checkins` — `pk='DAY'`, `dateKey` SK, attr `valuesJson`. The physical table name keeps `day-checkins` in it for historical reasons; the lambda code refers to it as the entries table.

   **Schema:**

   - per-entry `habitValuesById` — `{ habitId: boolean | number }`. A habit id with no defining cycle is stripped from every entry by the server sweep on the next cycle PUT/DELETE.
   - per-cycle `{ id, startDate, endDate, lengthDays, pointStep?, categories[], habitDefinitions[] }`. `pointStep` is one of `0.1 | 0.25 | 0.5 | 1` (default `1` if missing) and controls the +/- increment for `points` and `pointsPerUnit` in the Plan tab; `maxUnits` is always integer. The upcoming cycle inherits `pointStep` from the current cycle when auto-created. Habits are boolean or count with `scoring` / point rules. Cloned cycles keep the same habit id until the last copy is removed.

   **Plan-edit nudge:** past day 1 of the current cycle, opening the Plan tab auto-selects the **Next** mode so the user is steered toward editing the upcoming cycle. They can still toggle back to **Current** — when they do, a warning banner reminds them that editing the current cycle's rules can change scores already tallied today. No hard lock; just a default + warning.

3. **Privacy / telemetry.** No analytics, no third-party fonts or icons, no extra “phone home” beyond your own origin and `/api/cycles` + `/api/entries`.

4. **Deploy secrets.** `unlock_token` is passed only at deploy/synth (`--context unlock_token=...`). Never commit it. Stack outputs must **not** embed the raw token (use deploy scripts to print `https://…/?unlock=…` locally).

## Architecture

### App (`app/tracker.html`)

Vanilla JS. Rebuilds DOM from `state` on change; `data-action` delegation on `document.body`.

Source files under `app/scripts/`:
- `core.js` — state, helpers (`render`, `getCurrentCycle`, `getUpcomingCycle`, `cycleInfo`, `entryFor`, `pushCycle`, `pushEntry`, `applyOrphanSweepLocally`, `normalizeFirstCycleStartFromEntries`, `hasAnyEntries`).
- `entry-ui.js` — `renderEntry` (the per-day entry tab).
- `trends-ui.js` — `renderTrends`.
- `plan-ui.js` — `renderPlan`, `renderAddHabitModal` (the cycle-editor tab).
- `sync.js` — `bootSync`, debounced per-item `pushCycle`/`pushEntry`.
- `handlers.js` — single `data-action` click delegate.

### Infrastructure (`infrastructure/`)

| Piece | Region | Role |
|--------|--------|------|
| `CertStack` | us-east-1 | ACM cert, Lambda@Edge auth (viewer request) |
| `GoodHabitTrackerStack` | us-west-2 | S3 site, CloudFront, Route53 record, sync Lambda + URL, DynamoDB (`good-habit-tracker-cycles`, `good-habit-tracker-day-checkins`) |

Edge auth checks `htok` cookie (value = SHA-256 hex of deploy token) or `?unlock=` token (same hash). Sync Lambda requires `X-CF-Secret` header from CloudFront (derived from deploy token in stack code).

### Auth flow

1. `https://<host>/?unlock=<token>` → Edge validates, sets `htok` cookie, redirects to `/`
2. Valid cookie → pass request through
3. Otherwise → `403` minimal HTML

## Deploy

```bash
UNLOCK_TOKEN=your-secret-token ./deploy.sh
```

Or `deploy.ps1` on Windows. Scripts echo the bookmarkable unlock URL; they do not rely on CloudFormation outputs for the secret.

**Legacy DynamoDB:** Older stacks used `good-habit-tracker-state` (and possibly `habit-tracker-state`). After migrating to `good-habit-tracker-cycles` + `good-habit-tracker-day-checkins`, remove any **retained** old tables in **us-west-2** from the AWS console if CloudFormation left them behind.

**Backups:** `scripts/backup.ps1` (or `backup.sh`) reads `UNLOCK_TOKEN` from env, computes the `htok` cookie hash, calls `GET /api/cycles` + `GET /api/entries`, and writes a single timestamped JSON file to `backups/`. Run before any risky deploy or schema change.

### Lambda@Edge auth updates (export deadlock)

If changing the Edge auth Lambda while the main stack imports the cert stack’s export, deploy **in order** with `--exclusively`: (1) `GoodHabitTracker` with `--context temp_drop_edge_auth=true` (briefly ungated), (2) `GoodHabitTrackerCert`, (3) `GoodHabitTracker` again without `temp_drop_edge_auth`. `cert-stack.ts` replaces only the line `const UNLOCK_HASH = '__UNLOCK_HASH__';` in `lambdas/auth/index.js` — keep that placeholder out of comments.

### Unlock on phones

Bookmark the **encoded** URL from deploy output (or build it with `encodeURIComponent`). Auth uses raw query decode, not `URLSearchParams` (`+` → space). Cookie **`SameSite=Lax`** for iOS.

## When making changes

1. App behavior → `app/tracker.html` only (unless infra must change for the same feature).
2. Keep diffs focused; avoid opportunistic refactors.
3. Schema or API changes → update app **and** sync Lambda expectations together where needed.

## What to avoid unless explicitly requested

- Streaks / achievements / social features framed as pressure
- Heavy multi-tenant auth product on top of this minimal gate
- Telemetry and third-party trackers
