# HabitAgility — maintainer notes

Reference for humans and coding agents working in this repository.

## What this is

HabitAgility is an **Agile-style personal habit tracker**: two-week sprints,
velocity, burndown chart, retrospective, the whole Scrum vocabulary applied to
daily check-ins. It's a self-contained **single-file** web app
(`app/tracker.html`) plus a small **AWS CDK** stack. Designed for **personal**
hosting on an obscure subdomain with a Lambda@Edge cookie gate (+ unlock-link
for new devices).

See [README.md](./README.md) for the user-facing pitch. This file is for people
or agents *editing* the codebase.

### Brand vs infra naming

From **v0.11** onward, brand-facing **and** AWS infrastructure use the
**HabitAgility** name. The transition history is documented in the
[CHANGELOG](./CHANGELOG.md) — earlier versions had user-facing "HabitAgility"
over `good-habit-tracker-*` AWS resources until v0.11 did the full migration.

| Surface | Name |
|---|---|
| Product / UI / docs | **HabitAgility** |
| GitHub repo | **HabitAgility** |
| CDK stacks | `HabitAgilityCert` (us-east-1), `HabitAgility` (us-west-2) |
| DynamoDB tables | `habit-agility-meta`, `habit-agility-rows` |
| S3 bucket | `habit-agility-app-{account}` |
| Lambda functions | `habit-agility-sync`, `habit-agility-auth` |
| Subdomain | `ght.vexom.io` (will move to `habitagility.com` once registered) |

## Critical constraints (read before editing)

1. **Single-file HTML shell only** (`app/tracker.html`). Inline `<head>` + a
   module import for the JS modules in `app/scripts/`. No frameworks, no CDN
   dependencies.

2. **Cloud is the source of truth.** No `localStorage` for tracker data. The
   API is strict per-item REST under `/api/*`, gated by the CloudFront
   `X-CF-Secret` header (the lambda rejects anything missing it).
   **No bulk endpoints, ever. No DynamoDB Scans on read paths.**

   **Routes (see `infrastructure/lambdas/sync/index.js`):**
   - `GET /api/sprint/:id` → one sprint object or 404.
   - `POST /api/sprint` body `{ startDate, endDate, lengthDays, pointStep?,
     goalPoints, name, description, retrospective, categories, habitDefinitions }`
     → newly-assigned integer id. Server allocates the id atomically via
     `nextSprintId` on the meta row.
   - `PUT /api/sprint/:id` body same shape as POST → `{ ok, removedHabitIds }`.
     Server replaces the row, sweeps orphan habit ids from entries (bounded to
     sprint date ranges), re-stamps `sprintId` on entries when the date range
     moves, and invalidates the affected sprint summaries. Rejects
     `retrospective` edits on upcoming sprints (`startDate > today`) with 400.
   - `GET /api/entry/:dateKey` → `{ dateKey, habitValuesById, sprintId }` or
     404. One DDB `GetItem`. For a missing entry, falls back to the covering
     sprint via `findCovering` (covers planning-sprint fallback too).
   - `PUT /api/entry/:dateKey` body `{ habitValuesById }` → `{ ok }`. Server
     looks up the covering sprint, stamps `sprintId`, bumps entry-date bounds
     on the meta row via one read-modify-write `UpdateItem`. Empty
     `habitValuesById` deletes the row server-side. Triggers planning →
     started transition if the covering sprint had null `startDate`; response
     includes `{ sprintStarted: { sprintId, startDate, endDate } }` for the
     client to patch local state.
   - `GET /api/trend/sprint/:id` → daily-bucket trend for one sprint:
     `{ from, to, buckets: [{key, pts, goal, days}, ...] }`. Returns empty
     buckets for planning sprints.
   - `GET /api/trend/sprint-summary` →
     `{ summaries: [{sprintId, startDate, endDate, pts, days, goalPoints,
     goalTotal, name}, ...] }`. Lazy-filled into DDB, invalidated on
     entry/sprint writes (including name edits). Excludes planning sprints.

   The `/api/trend/*` paths and internal `trendsMode` state keys keep the
   "trend" name — the v0.10 user-facing rename to "Burndown" was UI-only to
   keep the API and code stable.

   **Boot** loads exactly two rows: `GET /api/entry/:today` + the covering
   sprint (id from the entry's stamped `sprintId`). Day navigation loads one
   entry at a time. The Burndown tab's *This Sprint* view fetches one
   sprint's daily detail; *All Sprints* fetches one summary collection.
   **Edits** debounce per item: `pushSprint(id)` and `pushEntry(date)` each
   at 1500 ms, keyed by id/date so concurrent edits to different items don't
   collide. Text edits (sprint name / description / retrospective) flow
   through a dedicated `input` event listener that updates state and
   debounces save **without re-rendering** — required to preserve focus and
   cursor position in textareas.

   **DynamoDB partitions** (in `habit-agility-rows`):
   - `pk='main#DAY'`, `dateKey` SK — entry rows. Attrs: `valuesJson`,
     `sprintId`, `updatedAt`.
   - `pk='main#SPRINT_DEF'`, `dateKey=String(sprintId)` SK — sprint
     definitions. Attrs: `startDate?`, `endDate?`, `lengthDays`, `pointStep?`,
     `goalPoints`, `name?`, `description?`, `retrospective?`, `bodyJson`
     (categories + habitDefinitions), `updatedAt`. Optional attrs are
     omitted from the row when empty (sparse-attribute pattern).
     **Planning sprints have null `startDate` + null `endDate`**; the first
     entry transitions them to "started" via `handlePutEntry`.
   - `pk='main#SPRINT_SUM'`, `dateKey=String(sprintId)` SK — sprint summary
     rows. Attrs: `startDate?`, `endDate?`, `pts`, `days`, `goalPoints`,
     `goalTotal`, `name?`, `updatedAt`.

   **Meta row** (in `habit-agility-meta`, partition `id='main'`):
   `nextSprintId`, `entryDateMin`, `entryDateMax`. Single row.

   **Schema:**
   - per-entry `habitValuesById` — `{ habitId: boolean | number }`. A habit id
     with no defining sprint is stripped from every entry by the server sweep
     on the next sprint PUT.
   - per-sprint `{ id, startDate, endDate, lengthDays, pointStep?, goalPoints,
     name, description, retrospective, categories[], habitDefinitions[] }`.
     `pointStep` is one of `0.1 | 0.25 | 0.5 | 1` (default `1`) and controls
     the Plan-tab Granularity selector; `dailyLimit = 0` means an unlimited
     count habit. `name` ≤ 80, `description` ≤ 2000, `retrospective` ≤ 5000
     chars (lambda clamps server-side as defense in depth). `pointStep` and
     `goalPoints` inherit from the previous sprint when auto-creating;
     `name` / `description` / `retrospective` do NOT inherit — each sprint
     starts blank.

   **Plan-edit nudge:** past day 1 of the current sprint, opening the Plan
   tab auto-selects the **Next** mode so the user is steered toward editing
   the upcoming sprint. They can toggle back to **Current** — when they do,
   a one-line warning banner reminds them that editing the current sprint's
   rules can change scores already tallied today.

   **Burndown tab** (v0.10+, formerly "Trends"):
   - **This Sprint** (default; `trendsMode: 'sprint'`) — prev/next walks
     every sprint. Shows name + description, an Agile **burndown chart**
     (ideal line from `(day 0, totalGoal)` → `(day N, 0)`, dashed; actual
     line from cumulative earned, clamped at 0; x-axis tick labels at start
     / mid / end days), POINTS + PACE metrics (PACE prefixed with ↑/↓/·
     glyph), and an editable retrospective textarea. Retrospective is
     locked on upcoming sprints (`startDate > today`) both client- and
     server-side.
   - **All Sprints** (`trendsMode: 'all'`) — single chart, one point per
     sprint at avg pts/day across the user's whole history. Per-sprint
     legend labels by `name || "Sprint N"`.

   **Plan-tab dates:** native `<input type="date">` for both Start and End
   (`data-field="sprint-start-date" | "sprint-end-date"`). Inline label +
   input on each row (since v0.10.4). The `change` event re-renders (length
   recalculates, end clamps ≥ start). The free-text fields keep the
   `input`-event no-render path.

   **Plan-tab SCORING section** (v0.10.4 vocabulary):
   - **Granularity** (formerly "Step") — choose the point precision first
     (`0.1 / 0.25 / 0.5 / 1`).
   - **Velocity** (formerly "Goal") — then pick the per-day points target.
   - Order matters: unit first, magnitude second.

3. **Privacy / telemetry.** No analytics, no third-party fonts or icons, no
   extra "phone home" beyond your own origin and `/api/*`.

4. **Deploy secrets.** `unlock_token` is passed only at deploy/synth
   (`--context unlock_token=…`). Never commit it. Stack outputs must not
   embed the raw token (use deploy scripts to print
   `https://…/?unlock=…` locally and out-of-band).

## Architecture

### App (`app/tracker.html`)

Vanilla JS. Rebuilds DOM from `state` on change; `data-action` delegation on
`document.body` for clicks, plus parallel `input` (text fields) and `change`
(date pickers) delegates.

Source files under `app/scripts/`:
- `constants.js` — debounces, defaults, length caps, API base paths.
- `scoring.js` — pure habit-points math + `canEditRetrospective`,
  `clampSprintText`, `isSprintInPlanning`. Mirrors the lambda's
  `pointsForEntry` (parity-tested).
- `types.js` — JSDoc `@typedef`s for Sprint, Entry, Habit, Category,
  SprintSummary, DayBucket.
- `core.js` — state, render orchestration, `getCurrentSprint`,
  `getSprintById`, `sprintInfo`, `pushSprint`, `pushEntry`,
  `applyOrphanSweepLocally`, `hasAnyEntries`. Re-exports constants +
  scoring helpers.
- `entry-ui.js` — `renderEntry` (per-day entry tab; sprint name +
  per-viewed-day day-in-sprint chip).
- `trends-ui.js` — `renderTrends`, `renderSprintOverview`, `renderAllTime`.
- `plan-ui.js` — `renderPlan`, `renderAddHabitModal`, `renderTextModal`
  (for category-add and rename), `renderActionMenuModal` (for the ⋯ menu
  on habits + categories).
- `sync.js` — `bootSync`, debounced per-item `pushSprint` / `pushEntry`,
  lazy loaders.
- `handlers.js` — click + input + change + keydown delegates; action maps
  grouped by tab (preBoot / global / entry / trends / plan).

### Infrastructure (`infrastructure/`)

| Stack | Region | Role |
|---|---|---|
| `HabitAgilityCert` | us-east-1 | ACM cert, Lambda@Edge auth (viewer-request), `LIVE` alias |
| `HabitAgility` | us-west-2 | S3 static site, CloudFront, Route 53 A-record, sync Lambda + URL, DynamoDB (`habit-agility-meta` + `habit-agility-rows`) |

Edge auth checks `htok` cookie (value = SHA-256 hex of deploy token) or
`?unlock=` querystring (same hash → set cookie + redirect). Sync Lambda
requires `X-CF-Secret` header from CloudFront (derived from the deploy token
in stack code).

### Auth flow

1. `https://<host>/?unlock=<token>` → Edge validates, sets `htok` cookie,
   redirects to `/` minus the `unlock=…` param.
2. Subsequent requests carry the cookie → Edge passes through.
3. Anyone without the cookie or correct unlock token → minimal `403 private`
   HTML page.

## Deploy

**Deploys go through GitHub Actions — no exceptions.** Push a version tag:

```bash
git tag 0.11.1 && git push origin 0.11.1
```

Or trigger manually: GitHub → Actions → "deploy" → Run workflow. The workflow
lints, tests, and runs `cdk deploy --all` from `infrastructure/`.

**Local `cdk deploy` is denied** by `.claude/settings.json` deny rules + a
`PreToolUse` hook (`.claude/block-local-deploy.js`) that catches wrapped
variants too (e.g. `Push-Location …; npx cdk deploy …`). `deploy.sh` and
`deploy.ps1` are kept for reference (what CI runs) but their invocation is
blocked. If you genuinely need to bypass for a one-off (rare), edit
`.claude/settings.json` yourself — agents can't unblock themselves.

### Lambda@Edge auth and token rotation

`cert-stack.ts` replaces only the line `const UNLOCK_HASH = '__UNLOCK_HASH__';`
in `lambdas/auth/index.js` at synth time — keep that placeholder out of
comments or it'll be substituted twice.

The cert stack publishes a **`LIVE` alias** on the auth function (`AuthFnLive`
construct) pointing to the current version. CloudFront itself needs the
numeric version ARN — CloudFront rejects alias ARNs — so the version is
passed cross-region from cert stack to main stack via CDK's SSM-backed
`crossRegionReferences` mechanism. The LIVE alias is there for CloudWatch
alarms and a future migration to alias-based references.

**Token rotation deploys normally** — push a tag with the new
`UNLOCK_TOKEN` set on the GitHub `production` environment. The cross-region
SSM export updates to the new version ARN; then CloudFront swaps. If a
deploy fails mid-way and CloudFormation gets stuck in `UPDATE_ROLLBACK_FAILED`
on `ExportsWriteruswest209BD44F0A7CF058B`, recover with:

```bash
aws cloudformation continue-update-rollback \
  --stack-name HabitAgilityCert --region us-east-1 \
  --resources-to-skip ExportsWriteruswest209BD44F0A7CF058B
```

then re-run `cdk deploy --all` via CI.

### Unlock on phones

Bookmark the **encoded** URL from deploy output (or build it with
`encodeURIComponent`). Auth uses raw query decode, not `URLSearchParams`
(`+` → space). Cookie is `SameSite=Lax` for iOS.

### Backups

`scripts/backup.ps1` (or `scripts/backup.sh`) reads `UNLOCK_TOKEN` from env,
computes the `htok` cookie hash, walks `/api/trend/sprint-summary`, fetches
each `/api/sprint/:id`, then iterates every covered date calling
`/api/entry/:dateKey`. Writes a single timestamped JSON file to `backups/`.
Run before any risky deploy or schema change. The DDB tables also have
point-in-time recovery enabled (up to 35 days).

## When making changes

1. App behavior → `app/scripts/*.js` (unless infra must change for the same
   feature).
2. Keep diffs focused; avoid opportunistic refactors mixed with feature
   changes.
3. Schema or API changes → update both `app/scripts/sync.js` (request shape)
   AND the lambda handlers in `infrastructure/lambdas/sync/` (response shape
   + DDB attrs).
4. New lambda helpers → put pure ones in `sprint-helpers.js` or `utils.js`
   (no `@aws-sdk/*` imports) so they're testable from `tests/`.

## What to avoid unless explicitly requested

- **Streaks, achievements, social** — the product's positioning is the
  *opposite* of these. The Agile cycle replaces streak anxiety; introducing
  streaks would undermine the product story.
- **Bulk API endpoints** — every read is per-item; every write debounces.
  Adding a bulk endpoint reintroduces the worst patterns from version-0 SaaS
  trackers.
- **DynamoDB Scans on the read path** — partition-targeted Query and GetItem
  only.
- **Multi-tenant auth** — single-user by design. The DDB partition prefix
  (`main#…`) is parameterized for a future multi-user fork, but adding
  signup / passwords / OAuth here is out of scope.
- **Telemetry / third-party scripts** — privacy is a feature.
