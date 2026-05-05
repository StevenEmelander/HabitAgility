# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.4] - 2026-05-05

### Added

- **Configurable point granularity per cycle** (`cycle.pointStep`: `0.1`, `0.25`, `0.5`, or `1`). The +/- buttons in Plan use this step for `points` and `pointsPerUnit`; `maxUnits` stays integer. Switching the step snaps every existing habit value onto the new grid (e.g., 0.25 → 0.5 turns 1.25 into 1.5). New cycles inherit `pointStep` from the cycle they're cloned from.
- **Step-aware display precision** throughout the app: `1/1` for step `1`, `1.0/1.0` for step `0.5` or `0.1`, `1.00/1.00` for step `0.25`. Each entry uses its own cycle's step, so old days render in their original precision.
- **Plan-tab edit safety**: opening Plan past day 1 of the current cycle auto-selects **Next**. Toggling back to Current shows a red warning banner — edits past day 1 can change scores already tallied.
- **Count-habit clarity**: the counter row now shows `n / maxUnits` (units progress), separate from the points conversion in the header.
- **Mode-specific trends endpoints** (one round-trip each):
  - `GET /api/trend/cycle/:id` — daily buckets within one cycle.
  - `GET /api/trend/month/:yyyy-mm` — daily buckets for a month.
  - `GET /api/trend/cycle-summary` — one aggregate per cycle (year + all-time views share this).
- **Cycle-summary storage** at `pk='main#CYCLE_SUM'`, lazy-filled on first read and invalidated on entry/cycle writes. All-time trends become O(1) DynamoDB Query after first view.
- **`POST /api/cycle`** with server-assigned integer ids (atomic `nextCycleId` increment on the meta row). Front-end never picks an id.
- **`userId`-prefixed partition keys** on every DynamoDB row (`main#DAY`, `main#CYCLE_DEF`, `main#CYCLE_SUM`). Multi-user is now a one-line change — replace the `USER_ID` constant with a per-request lookup.

### Changed

- **Strict per-day entry loading.** Boot fetches only `GET /api/entry/:today` plus `GET /api/cycle/:id`. Day navigation loads exactly one entry. No more bulk-load on app start.
- **Cycle ids are positive integers** (1, 2, 3, …). Trends prev/next cycle is `id ± 1`. UUIDs from prior versions are migrated in place.
- **Cycles split into per-row items** (`pk='main#CYCLE_DEF'`, sk=`cycleId`) instead of one `cyclesJson` blob. PUT cycle is O(1) regardless of total cycle count and no longer bound by DynamoDB's 400 KB item limit.
- **Entry rows carry `cycleId`**, stamped at write time. Entry GET is one round-trip; re-stamped on cycle PUT when the date range moves.
- **Orphan-habit sweep is conditional** — only runs when habit ids are genuinely orphaned (removed from this cycle and not present in any other). Bounded to the union of cycle ranges.
- **Parallel cycle-summary fill** via `Promise.all` over missing cycles.
- **Bounds bump consolidates to one round-trip** (initial `if_not_exists` + two parallel conditional extends) instead of three sequential UpdateItems.
- **Trends UI driven by mode-specific data sources**: cycle/month modes plot daily buckets; year/all-time plot one point per cycle at its `startDate` (cycle averages).
- **Front-end `state.cycles[]` removed**, replaced with sparse `state.cyclesById` map. The full cycle list is never held in memory.

### Removed

- **Bulk endpoints**: `GET /api/cycles`, `GET /api/entries`.
- **DELETE endpoints**: `DELETE /api/cycle/:id`, `DELETE /api/entry/:date`. PUT entry with empty `habitValuesById` deletes server-side; nothing in the UI deletes a cycle.
- **`cyclesJson` blob** on the meta row. Cycles are now individual rows.
- Date-range query parameters on entry endpoints — strict per-item access only.

### Migration (idempotent, runs on first request after deploy)

- Cycle UUIDs → integer ids (sorted by `startDate`).
- `cyclesJson` blob → individual `CYCLE_DEF` rows.
- Plain `pk='DAY'` entry rows → `pk='main#DAY'` with `cycleId` stamped from the covering cycle.
- Plain `pk='CYCLE'` summary rows → `pk='main#CYCLE_SUM'`.

## [0.3] - 2026-04-28

### Added

- **Per-item REST API** under `/api/*`: `GET/PUT/DELETE /api/cycles/:id`, `GET/PUT/DELETE /api/entries/:date`, plus `GET /api/cycles` and `GET /api/entries` for boot. All reads are partition-targeted Query / GetItem (no Scans, no date-range parameters).
- **Per-item debounced writes** in the front-end: `pushCycle(id)` and `pushEntry(date)` keyed by item, replacing the previous "send the whole world on every edit" path. Toggling a checkbox now produces exactly one `PUT /api/entries/:date` and no cycles traffic.
- **Server-side orphan-habit sweep**: when a cycle is updated or removed, the lambda strips habit ids that are no longer defined by any cycle from every entry row and returns `removedHabitIds` so the front-end mirrors the sweep locally.
- **Backup script** at `scripts/backup.ps1` (and `backup.sh`): hits the new endpoints with the `htok` cookie and writes a single timestamped JSON file to `backups/`.

### Changed

- **Naming consistency throughout.** Renamed `today` UI references to `entry`/`entries` and `tune` references to `plan`. File renames `today-ui.js` → `entry-ui.js`, `tune-ui.js` → `plan-ui.js`. Function renames `renderToday` → `renderEntry`, `renderTune` → `renderPlan`. State renames `state.checkinsByDate` → `state.entriesByDate`, `state.checkinBounds` → `state.entryBounds`, `state.tuneMode` → `state.planMode`. CSS classes `.tune-*` → `.plan-*`. Wire field `checkinBounds` → `entryBounds`. DynamoDB attributes `checkinDateMin/Max` → `entryDateMin/Max` (existing data migrated in place). Tab label `TUNE` → `PLAN`.
- **Storage layout** is unchanged at the table level (same names, same partition keys); the lambda now exposes per-item endpoints over the existing rows. Bounds are maintained incrementally on every entry put/delete instead of by scanning the entire entries table on every write.
- **Boot** is two parallel calls (`GET /api/cycles` + `GET /api/entries`) instead of a single 730-day range fetch.

### Removed

- **Legacy `/api/sync` route.** GET (`?from=&to=`) and POST (`partial: true` / `deletedCheckinDates[]`) are gone; cutover was atomic.
- **Legacy front-end paths**: `schedulePush`, `purgeOrphanHabitData` (now server-side), `_loadedRange`, `ensureDayLoadedThenRender`, `ensureTrendsRangeLoaded`, `fetchCheckinsRange`, `rangeFullyLoaded`, `stripLegacyRestFromCheckins`. The orphan-`isRestDay` cleanup is no longer needed.
- **Legacy DynamoDB attribute** `_lastModified` on the cycles row.

## [0.2] - 2026-04-27

### Added

- **Modular app:** Styles and scripts split into `app/styles/` and `app/scripts/` while keeping a single deployable `app/tracker.html` shell.
- **Trends:** Day, week, month, and year summaries; dual charts and a 30-day view from loaded cloud data (no local backup/export UI).
- **Tune & copy:** Tune UX polish; clearer **entries** wording where it replaces older labels.

### Changed

- **Sync & storage:** Replaced the single DynamoDB blob with **`good-habit-tracker-cycles`** (one item: `cycles` JSON + `_lastModified` + check-in date bounds) and **`good-habit-tracker-day-checkins`** (`pk = DAY`, `dateKey` sort key) for efficient **Query** by date range.
- **API:** `GET /api/sync?from=YYYY-MM-DD&to=YYYY-MM-DD` returns check-ins in range plus `checkinBounds`. `POST` supports **`partial: true`** with only changed days and **`deletedCheckinDates`**; full replace when `partial` is false (replaces all remote day rows from the payload).
- **App:** Partial cloud saves for edited days; cycle logic and rendering aligned with multi-cycle habits.
- **Infra:** CloudFront forwards query strings to the sync origin; CDK **`S3BucketOrigin.withOriginAccessIdentity`** replaces deprecated `S3Origin`. Deploy scripts and stack wiring updated for the sync path.

### Removed

- Legacy DynamoDB tables **`good-habit-tracker-state`** and **`habit-tracker-state`** (superseded single-table designs). If you upgraded from an older stack, delete any retained empty tables in **us-west-2** that match those names.

