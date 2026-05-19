# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- **"Planning" sprint state.** A sprint created when no other sprint exists (typically the very first one, also any first-sprint-after-a-gap-day via `ensureCurrentSprint`) is born with `startDate = null` and `endDate = null`. The Plan tab renders its start input as today's date (disabled), its end input as `today + lengthDays − 1` (editable — adjusts duration), and tags the day-count line with `· planning`. The lambda's `findCovering` falls back to the lowest-ID planning sprint when no started sprint covers the queried date, so the Entry tab and entry GETs work seamlessly while planning.
- **First-entry transitions the sprint.** When the lambda's `handlePutEntry` stamps the first entry against a planning sprint, it sets `startDate = entry.dateKey`, `endDate = startDate + lengthDays − 1`, and returns the new dates in `{ sprintStarted: { sprintId, startDate, endDate } }`. The client patches local state on receipt so the UI flips from "PLANNING" to "DAY 1 / N" without a full reload.
- **Date pickers are locked after start.** Both start and end inputs on the Plan tab are `disabled` once a sprint has a real `startDate`. This trades the escape-hatch for cleaner semantics — sprint dates are immutable once you've actually started doing the work. (`lengthDays` is implicitly locked too, since the buttons that adjusted it were removed in this release.)
- **`isSprintInPlanning(sprint)` helper** in `scoring.js`, re-exported via `core.js`. Used by Plan UI, Trends UI, and the date-change handler.

### Removed

- **`±14d` length stepper buttons on the Plan tab.** Redundant with the start/end date pickers — adjust via dates. Length still displays below the date row.

### Changed

- **New sprints always default to 14 days** regardless of the prior sprint's length. `pointStep` and `goalPoints` still inherit (they're scoring settings the user has tuned), but length doesn't — the date pickers are the right surface for adjusting a specific sprint's window. Affects both first-sprint creation (`ensureCurrentSprint`) and next-sprint creation (Plan tab → Next).
- **Trends Sprint Overview gracefully handles planning sprints.** Header shows "Not started yet · N days planned" instead of `null → null`. Metrics and the burndown chart are replaced by a single message pointing to the Entries tab. Retrospective stays hidden (lambda + UI both gate on `canEditRetrospective`, which is false for planning sprints).
- **Header bar reads `PLANNING`** instead of `DAY N/M` when the current sprint hasn't started yet.
- **iOS auto-zoom fix.** Sprint name/description inputs, date pickers, and the retrospective textarea bumped to `font-size: 16px`. Safari only auto-zooms on focus when the input font-size is below 16, so this disables the unwanted zoom without touching viewport `user-scalable` (which would block accessibility pinch-zoom).

## [0.7] - 2026-05-19

### Added

- **Burndown chart in Trends → Sprint Overview.** Replaces the daily-points line chart with an Agile-style burndown: a dashed ideal line from `(day 0, totalGoal)` to `(day N, 0)`, and a solid actual line that tracks `totalGoal − cumulative earned` per day. Sitting below the ideal means you're ahead of pace.
- **PACE metric** alongside POINTS in Sprint Overview. Shows `±N` (color-coded — ahead in accent, behind in danger, on-pace in muted) plus `day X / Y` for at-a-glance progress.
- **Sprint date pickers in Plan tab.** Native `<input type="date">` for both start and end. End date clamps to start; length recalculates on commit; `change` event re-renders (vs the `input` no-render path used for free-text fields). Future-proofs date editing beyond the ±N stepper. Pickers stack to a single column below 480 px so iPhone widths don't overflow.
- **`LIVE` alias on the Lambda@Edge auth function.** Stable handle for monitoring and manual invocation. CloudFront still references the version ARN (Lambda@Edge rejects alias ARNs).
- **`.claude/settings.json` + `PreToolUse` hook (`block-local-deploy.js`)** that block local `cdk deploy`, `deploy.ps1`, and `deploy.sh` invocation — including substring-matched wrapped variants like `Push-Location infrastructure; npx cdk deploy ...`. Forces deploys through GitHub Actions.

### Changed

- **Trends Sprint Overview header.** Sprint name (or `Sprint N` fallback) now sits inline between the prev/next arrows instead of a separate row below the muted `SPRINT N` caption. Cleaner, less vertical space, no duplicate identifier.
- **Empty description/retrospective hide entirely** instead of showing italic "No description." placeholder text. Past + current sprints with no retro still show the editable input so the user can add one; upcoming sprints hide the retro block completely.
- **POINTS metric reformats to `X / total`** (instead of `X` plus a separate "of total" subtext) with `N left` underneath. Less wrapping on narrow phones. PACE subtext font is smaller for the same reason.
- **Length stepper is now ±14d** (was ±7d), aligning with the default sprint length. Minimum floor for the stepper is 1 day (date pickers can go anywhere).

### Removed

- **`temp_drop_edge_auth` CDK context.** The two-phase deploy workaround is no longer the documented path. Recovery from the rare `ExportsWriter` rollback-stuck state is now: `aws cloudformation continue-update-rollback --resources-to-skip ExportsWriteruswest209BD44F0A7CF058B --stack-name GoodHabitTrackerCert --region us-east-1`, then re-run `cdk deploy --all` via CI.

## [0.6] - 2026-05-18

### Added

- **Sprint name + description + retrospective.** Every sprint now carries optional `name` (≤80 chars), `description` (≤2000), and `retrospective` (≤5000) fields. Name and description are edited in the Plan tab sprint card; retrospective is edited in the new Trends → Sprint Overview view. Each is backward compatible — existing sprints read as empty strings until edited.
- **Sprint name in Entry header.** When a sprint has a name, it renders above the date line on the Entry tab — gives daily context (e.g. "Hibernation Recovery") without taking real estate when unset.
- **`canEditRetrospective(sprint, todayKey)` + `clampSprintText(value, max)`** helpers in `app/scripts/scoring.js`. Pure, testable. Lambda mirrors via `clampText` in `utils.js`.
- **Tests.** 12 new test cases covering `canEditRetrospective` (past / current / first-day / upcoming / null) and `clampSprintText` (trim, slice, coerce, empty).

### Changed

- **Trends redesigned: two modes only.** `SPRINT OVERVIEW` (default) walks every sprint with prev/next — name, description, daily-points chart with goal line, summary stats, and editable retrospective. `ALL-TIME` plots one point per sprint at avg pts/day across the user's whole history, with a per-sprint legend. The four-mode switcher (sprint / month / year / all) is gone.
- **Sprint summary row gains `name`.** Powers the All-Time chart's sprint labels without a per-sprint round trip. Invalidated when a sprint's name changes (`handlePutSprint` summary-invalidation gap caught in plan review and fixed).
- **Text-edit focus preservation.** Sprint name/description/retrospective edits flow through a dedicated `input` event listener that updates state and debounces save **without re-rendering**. Going through the click pipeline would have rebuilt the DOM and dropped focus + cursor position on every keystroke.
- **Retrospective gating (defense in depth).** UI disables the retro textarea on upcoming sprints; lambda also rejects retrospective edits with 400 when `body.startDate > today`.

### Removed

- **Trends month-mode endpoint** (`GET /api/trend/month/:yyyy-mm`) and its handler.
- **Trends month + year modes** in the UI. `state.trendsMonth` and `state.trendsYear` removed.
- **`isValidYyyymm` helper** in lambda utils (unused after month route removal).
- **`todayYearMonth` / `todayYear` / `offsetMonth` helpers** in front-end handlers (dead code without month/year modes).

## [0.5] - 2026-05-07

### Added

- **`Goal` replaces `Max`** as the headline ceiling concept. New per-sprint `goalPoints` field (daily, default `10`); UI shows `pts / goal`; trends chart has a dashed goal reference line; the bounded "max possible" math is gone from the user-facing UI.
- **Unlimited count habits.** Setting a count habit's daily limit to `0` makes it open-ended — counter has no upper clamp; UI renders `n` (not `n / limit`); `Limit: ∞` in Plan.
- **Renamed `Cycle` → `Sprint`** throughout: API routes (`/api/sprint/*`, `/api/trend/sprint/*`, `/api/trend/sprint-summary`), DDB partition keys (`main#SPRINT_DEF`, `main#SPRINT_SUM`), the entry-row attribute (`sprintId`), UI labels, CSS class names, and every code symbol. The meta-row's `nextCycleId` becomes `nextSprintId`. Aligns terminology with the Agile sprint model.
- **Tests.** Vitest setup at the repo root with parity tests for `pointsForEntry` (lambda ↔ front-end), `quantize`, `fmtPoints`, `fmtPointsForStep`, `decimalsForStep`, `pointStep`, `goalForSprint`. 24 tests passing.
- **Linter + formatter.** Biome at the repo root: `npm run check`, `npm run check:fix`. Auto-formatted the entire codebase to a single consistent style.
- **GitHub Actions CI.** `.github/workflows/ci.yml` runs Biome + Vitest + `cdk synth` on every PR. `.github/workflows/deploy.yml` runs the gate + `cdk deploy` on tag pushes (`X.Y` / `X.Y.Z`) and on manual dispatch.
- **JSDoc types** for Sprint, Entry, Habit, Category, Summary, DayBucket in `app/scripts/types.js` — IDE autocomplete on the shared shapes without adding TypeScript.

### Changed

- **Lambda split into modules.** The 700-line single-file lambda is now 10 cohesive modules: `index.js` (router + dispatch), `constants.js`, `utils.js`, `db.js`, `scoring.js`, `meta.js`, `sprints.js`, `entries.js`, `summaries.js`, `orphan-sweep.js`. Behavior is unchanged.
- **Front-end constants centralized** in `app/scripts/constants.js` (debounces, default goal, default sprint length, default point step, API base paths, chart caps). The math is in `app/scripts/scoring.js` (pure, no state, no DOM); `core.js` re-exports both so existing import sites keep working.
- **handlers.js refactored to an action map.** Replaced the 26-branch `if (action === '...')` chain with `preBootActions` / `globalActions` / `entryActions` / `trendsActions` / `planActions` lookup tables. Each handler is a small function receiving `{ event, target, action, id, delta }`.
- **`bumpBoundsOnPut` collapses 3 DDB UpdateItems into 1** read-modify-write. Caller can pass a pre-fetched meta row to skip the extra read entirely. ~67% fewer write ops on the entry-edit hot path.
- **Multi-user-ready namespace** kept in place: every DDB key is prefixed via `userKey()`; sprint defs are individual rows under `pk='main#SPRINT_DEF'`; sprint summaries under `pk='main#SPRINT_SUM'`; entry rows carry `sprintId` for one-round-trip GETs.

### Removed

- **All migration scaffolding** (the cycle→sprint migration ran once on the first deploy, then was stripped in the next deploy). No legacy attribute fallbacks anywhere; no `ensureMigrated` plumbing.
- **The "max points" concept** in the UI. The progress bar and trends charts now key off `goalPoints` instead of `totalMax`. `habitMax`, `categoryMax`, `totalMax` removed from core.js. The cycle-summary's `max` attribute is gone (re-deriveable from `goalPoints × days`).

### Migration (one-shot, ran on first request after deploy; no longer in the code)

- DDB partition `main#CYCLE_DEF` → `main#SPRINT_DEF` (rows rewritten in place).
- DDB partition `main#CYCLE_SUM` → `main#SPRINT_SUM` (old summaries dropped, lazy-fill on next trends view).
- Entry-row attribute `cycleId` → `sprintId`.
- Meta-row attribute `nextCycleId` → `nextSprintId`.

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

