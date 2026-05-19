# Good Habit Tracker — maintainer notes

Reference for humans and coding agents working in this repository.

## What this is

A self-contained **single-file** web app (`app/tracker.html`) plus a small **AWS CDK** stack. Intended for **personal** hosting: obscure hostname, Lambda@Edge cookie gate, optional unlock query parameter for new devices.

## Critical constraints (read before editing)

1. **Single-file HTML only** (`app/tracker.html`). Inline CSS/JS. No external CSS, frameworks, or CDN dependencies for the app shell.

2. **Cloud is the source of truth.** No `localStorage` for tracker payload. The API is strict per-item REST under `/api/*`, gated by the CloudFront `X-CF-Secret` header (the lambda rejects anything missing it). **No bulk endpoints, ever.** No Scans, ever.

   **Routes (current — see `infrastructure/lambdas/sync/index.js`):**
   - `GET /api/sprint/:id` → one sprint object or 404.
   - `POST /api/sprint` body `{ startDate, endDate, lengthDays, pointStep?, goalPoints, name, description, retrospective, categories, habitDefinitions }` → newly assigned integer id. Server allocates the id atomically via `nextSprintId` on the meta row.
   - `PUT /api/sprint/:id` body same shape as POST → `{ ok, removedHabitIds }`. Server replaces the row, sweeps orphan habit ids from entries (bounded to sprint date ranges), re-stamps `sprintId` on entries when the date range moves, and invalidates the affected sprint summaries. Rejects `retrospective` edits on upcoming sprints (`startDate > today`) with 400.
   - `GET /api/entry/:dateKey` → `{ dateKey, habitValuesById, sprintId }` or 404. One DDB `GetItem`.
   - `PUT /api/entry/:dateKey` body `{ habitValuesById }` → `{ ok }`. Server looks up the covering sprint, stamps `sprintId`, bumps entry-date bounds on the meta row via one read-modify-write `UpdateItem`. Empty `habitValuesById` deletes the row server-side.
   - `GET /api/trend/sprint/:id` → daily-bucket trend for one sprint: `{ from, to, buckets: [{key, pts, goal, days}, ...] }`.
   - `GET /api/trend/sprint-summary` → `{ summaries: [{sprintId, startDate, endDate, pts, days, goalPoints, goalTotal, name}, ...] }`. Lazy-filled into DDB, invalidated on entry/sprint writes (including name edits).

   **Boot** loads exactly two rows: `GET /api/entry/:today` + `GET /api/sprint/:id` (id from the entry's `sprintId`). Day navigation loads one entry at a time. Trends Sprint Overview fetches one sprint's daily detail; All-Time fetches one summary collection. **Edits** debounce per item: `pushSprint(id)` and `pushEntry(date)` each at 1500ms, keyed by id/date so concurrent edits to different items don't collide. Text edits (name/description/retrospective) flow through a dedicated `input` event listener that updates state and debounces save **without re-rendering** — required to preserve focus + cursor position in textareas.

   **DynamoDB partitions (single table, single physical table name retained for history):**
   - `pk='main#DAY'`, `dateKey` SK — entry rows. Attrs: `valuesJson`, `sprintId`, `updatedAt`.
   - `pk='main#SPRINT_DEF'`, `dateKey=String(sprintId)` SK — sprint definition rows. Attrs: `startDate`, `endDate`, `lengthDays`, `pointStep?`, `goalPoints`, `name?`, `description?`, `retrospective?`, `bodyJson` (categories + habitDefinitions), `updatedAt`. Optional string attrs are omitted from the row when empty (mirror the `pointStep` pattern).
   - `pk='main#SPRINT_SUM'`, `dateKey=String(sprintId)` SK — sprint summary rows. Attrs: `startDate`, `endDate`, `pts`, `days`, `goalPoints`, `goalTotal`, `name?`, `updatedAt`.
   - Meta row (separate physical table): `nextSprintId`, `entryDateMin`, `entryDateMax`. Single row, partition `id='main'`.

   **Schema:**

   - per-entry `habitValuesById` — `{ habitId: boolean | number }`. A habit id with no defining sprint is stripped from every entry by the server sweep on the next sprint PUT.
   - per-sprint `{ id, startDate, endDate, lengthDays, pointStep?, goalPoints, name, description, retrospective, categories[], habitDefinitions[] }`. `pointStep` is one of `0.1 | 0.25 | 0.5 | 1` (default `1`) and controls Plan-tab steppers; `dailyLimit = 0` means an unlimited count habit. `name` ≤ 80, `description` ≤ 2000, `retrospective` ≤ 5000 chars (lambda clamps server-side as defense in depth). `pointStep` and `goalPoints` inherit from the previous sprint when auto-creating; `name`/`description`/`retrospective` do NOT inherit — each sprint starts blank.

   **Plan-edit nudge:** past day 1 of the current sprint, opening the Plan tab auto-selects the **Next** mode so the user is steered toward editing the upcoming sprint. They can still toggle back to **Current** — when they do, a warning banner reminds them that editing the current sprint's rules can change scores already tallied today.

   **Trends tab (v0.6+):** two modes only.
   - **Sprint Overview** (default) — prev/next walks every sprint. Shows name, description, an Agile **burndown chart** (ideal line from `(day 0, totalGoal)` → `(day N, 0)`, dashed; actual line from cumulative earned, clamped at 0), POINTS + PACE metrics, and an editable retrospective textarea. Retrospective is locked on upcoming sprints (`startDate > today`) both client- and server-side.
   - **All-Time** — single chart, one point per sprint at avg pts/day across the user's whole history. Per-sprint legend labels by `name || "Sprint N"`.

   **Plan-tab dates:** native `<input type="date">` for both start and end (`data-field="sprint-start-date" | "sprint-end-date"`). The `change` event re-renders (length recalculates, end clamps ≥ start); text fields keep the `input` no-render path. A `±14d` stepper coexists for quick length adjustments.

3. **Privacy / telemetry.** No analytics, no third-party fonts or icons, no extra "phone home" beyond your own origin and `/api/*`.

4. **Deploy secrets.** `unlock_token` is passed only at deploy/synth (`--context unlock_token=...`). Never commit it. Stack outputs must **not** embed the raw token (use deploy scripts to print `https://…/?unlock=…` locally).

## Architecture

### App (`app/tracker.html`)

Vanilla JS. Rebuilds DOM from `state` on change; `data-action` delegation on `document.body` for clicks, plus a parallel `input` delegate for text fields (preserves focus across edits).

Source files under `app/scripts/`:
- `constants.js` — debounces, defaults, length caps, API base paths.
- `scoring.js` — pure habit-points math + `canEditRetrospective`, `clampSprintText`. Mirrors the lambda's `pointsForEntry` (parity-tested).
- `types.js` — JSDoc `@typedef`s for Sprint, Entry, Habit, Category, SprintSummary, DayBucket.
- `core.js` — state, render orchestration, `getCurrentSprint`, `getSprintById`, `sprintInfo`, `pushSprint`, `pushEntry`, `applyOrphanSweepLocally`, `hasAnyEntries`. Re-exports constants + scoring helpers.
- `entry-ui.js` — `renderEntry` (per-day entry tab; shows sprint name above date when set).
- `trends-ui.js` — `renderTrends`, `renderSprintOverview`, `renderAllTime`.
- `plan-ui.js` — `renderPlan`, `renderAddHabitModal` (sprint-editor tab).
- `sync.js` — `bootSync`, debounced per-item `pushSprint`/`pushEntry`, lazy loaders.
- `handlers.js` — click + input delegates; action maps grouped by tab.

### Infrastructure (`infrastructure/`)

| Piece | Region | Role |
|--------|--------|------|
| `CertStack` | us-east-1 | ACM cert, Lambda@Edge auth (viewer request) |
| `GoodHabitTrackerStack` | us-west-2 | S3 site, CloudFront, Route53 record, sync Lambda + URL, DynamoDB (`good-habit-tracker-cycles` meta + `good-habit-tracker-day-checkins` rows — physical table names retained from earlier versions) |

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

**Backups:** `scripts/backup.ps1` (or `backup.sh`) reads `UNLOCK_TOKEN` from env, computes the `htok` cookie hash, dumps every sprint + entry via the per-item REST API, and writes a single timestamped JSON file to `backups/`. Run before any risky deploy or schema change.

### Lambda@Edge auth and token rotation

`cert-stack.ts` replaces only the line `const UNLOCK_HASH = ‘__UNLOCK_HASH__’;` in `lambdas/auth/index.js` — keep that placeholder out of comments.

The cert stack also publishes a **`LIVE` alias** (`AuthFnLive`) on the auth function pointing to the current version. CloudFront itself still needs the numeric version ARN (CloudFront rejects alias ARNs), which is passed cross-region from cert stack to main stack via CDK’s SSM-backed `crossRegionReferences` mechanism. The LIVE alias exists for monitoring and future architectural options.

**Token rotation deploys normally** — just run `./deploy.ps1` (or `cdk deploy --all`) with the new token. The cross-region SSM export updates to the new version ARN, then CloudFront is updated. If a deploy fails mid-way and CloudFormation gets stuck in UPDATE_ROLLBACK_FAILED on `ExportsWriteruswest209BD44F0A7CF058B`, recover with:
```
aws cloudformation continue-update-rollback --stack-name GoodHabitTrackerCert --region us-east-1 --resources-to-skip ExportsWriteruswest209BD44F0A7CF058B
```
Then re-run `cdk deploy --all` once credentials and connectivity are confirmed.

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
