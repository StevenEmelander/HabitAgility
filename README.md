# HabitAgility

> **Treat your habits like a Scrum team treats their work.** Two-week sprints. Daily check-ins. A burndown chart that doesn't lie. A retrospective at the end. Then plan the next sprint and run it again.

![HabitAgility](docs/hero-shot.png) <!-- placeholder; replace with a real screenshot -->

Most habit trackers run on **streaks** — endless chains you're afraid to break. They turn a single bad day into a failure. The pressure compounds, the chain breaks, you give up.

**HabitAgility runs on sprints instead.** Two weeks. A velocity goal (points per day). A burndown chart showing whether you're on pace. At the end you write a short retrospective and plan the next one. There's no chain to break — just a cycle to learn from.

---

## Why this works

| Streak trackers | HabitAgility |
|---|---|
| One bad day kills the streak | One bad day is a data point in this sprint's burndown |
| No structured review | Built-in retrospective at end of each sprint |
| Indefinite — feels like forever | Time-boxed — feels finite, completable, restartable |
| Gamified guilt | Honest pace measurement (ahead / behind / on pace) |
| Phone-app data sold or analyzed | Your data, your AWS account, zero third parties |

**The Agile insight applied to personal habits:** short feedback loops beat heroic discipline. You don't need to be perfect for 365 days; you need a 14-day sprint that's mostly good, followed by an honest look at what worked, followed by a tuned next sprint.

---

## What you get

### Three tabs — the whole product

**ENTRIES** — your daily check-in. Tap to mark Yes/No habits done. Counter buttons for "how many." Per-day points roll up against the day's velocity goal. Navigate to past days; the burndown updates accordingly.

**BURNDOWN** — the Scrum-style chart, with a twist. *This Sprint* shows the dashed ideal line (where you'd be on pace) and the solid actual line (where you actually are). The PACE metric shows `↑ ahead`, `↓ behind`, or `· on pace` at a glance. *All Sprints* is your history — one point per past sprint at its avg velocity.

**PLAN** — set up the sprint. Name it ("Recovery Week", "Q1 Reset"). Write the intent. Pick the dates (start auto-locks to your first entry — no awkward pre-commitments). Set **Granularity** (the point precision: 0.1 / 0.25 / 0.5 / 1) and **Velocity** (the per-day target). Group habits into categories with accent colors.

### The vocabulary, made explicit

| Term | What it means here |
|---|---|
| **Sprint** | A 14-day work cycle (default; configurable). Has a name, dates, intent, and a retrospective. |
| **Velocity** | Your per-day points goal for this sprint. The burndown's slope. |
| **Granularity** | The point increment — `0.1`, `0.25`, `0.5`, or `1`. Use `0.5` for "half-credit" habits; use `0.1` if you want to weight precisely. |
| **Burndown** | Cumulative-progress chart. Ideal line: total goal → 0 across the sprint. Actual line: how much you have left. Below ideal = ahead. |
| **PACE** | `(points earned) − (ideal-points-by-now)`. Color-coded — accent for ahead, danger for behind, muted for on-pace. |
| **Retrospective** | Free-text reflection you write at the end (or during) the sprint. Unlocks once the sprint starts. |
| **Planning** | A sprint that's been set up but never had an entry. Its start date floats to "today" until you make the first entry, which locks it. |

### Designed for adults

- **No streaks.** No "you broke your streak!" shaming.
- **No achievements.** No badges, no levels, no leaderboards.
- **No social.** Single-user by design.
- **No analytics.** No third-party fonts, scripts, or CDNs.
- **No app store.** Web app on your phone's home screen.

---

## Privacy & ownership

Your habit data lives in **your own AWS account**, in **your own DynamoDB tables**. There is no HabitAgility, Inc. There is no SaaS account. There is no "we" who can see your data.

- Hosted at your own subdomain.
- Gated by a [Lambda@Edge](./infrastructure/lambdas/auth/index.js) cookie check — only requests with your `htok` cookie or unlock query parameter get through. Everyone else gets a `403 private` page.
- API is gated separately by a CloudFront-injected `X-CF-Secret` header — the API origin (Lambda function URL) won't accept direct calls.
- No client-side analytics. The app shell loads no third-party origins. Inspect the network tab; it's all your-subdomain or your-API.

---

## Quick start

You'll need an AWS account, a Route 53 hosted zone, and ~10 minutes.

```bash
# 1. Clone
git clone https://github.com/StevenEmelander/HabitAgility.git
cd HabitAgility

# 2. Install root + infrastructure deps
npm ci
cd infrastructure && npm ci && cd ..

# 3. Pick a deploy secret (any high-entropy string — generate with `openssl rand -hex 32`)
$env:UNLOCK_TOKEN = "your-secret-token"  # PowerShell
# or: export UNLOCK_TOKEN=your-secret-token  # bash

# 4. Update the domain in infrastructure/lib/cert-stack.ts and stack.ts
#    (replace 'ght.vexom.io' / 'vexom.io' with your subdomain + zone)

# 5. Deploy
cd infrastructure
npx cdk deploy --all --require-approval never --context "unlock_token=$env:UNLOCK_TOKEN"

# 6. Bookmark the unlock URL printed at the end:
#    https://your-subdomain.example.com/?unlock=your-secret-token
```

CI/CD is wired up: push a tag like `0.11.0` and `.github/workflows/deploy.yml` does the same thing from GitHub Actions. **Local `cdk deploy` is blocked** by a `.claude/settings.json` hook to force the CI path for repeatability — see [CLAUDE.md](./CLAUDE.md) for the recovery procedure if a deploy gets stuck.

---

## Architecture

A small, intentional surface:

```
┌──────────────────┐    htok cookie / ?unlock=     ┌─────────────────────────┐
│  iPhone / Web    │ ───────────────────────────▶ │ CloudFront (us-east-1)  │
└──────────────────┘                              │  + Lambda@Edge auth     │
                                                  └────────────┬────────────┘
                                                               │
                                              S3 static site / │ X-CF-Secret
                                                               ▼
                                                  ┌─────────────────────────┐
                                                  │ Lambda Function URL     │
                                                  │  (us-west-2, Node 20)   │
                                                  │   strict per-item REST  │
                                                  └────────────┬────────────┘
                                                               │
                                                               ▼
                                                  ┌─────────────────────────┐
                                                  │ DynamoDB (us-west-2)    │
                                                  │  meta + rows tables     │
                                                  │  PAY_PER_REQUEST        │
                                                  └─────────────────────────┘
```

- **Front end:** one HTML file + ES-module JS, no frameworks, no CDN dependencies. Mobile-first dark theme.
- **API:** strict per-item REST under `/api/*`. No bulk endpoints. No DynamoDB Scans ever. Boot loads exactly 2 rows.
- **DDB partitioning:** single-table-ish; `pk='main#DAY'` for entries, `pk='main#SPRINT_DEF'` for sprint definitions, `pk='main#SPRINT_SUM'` for cached summaries.
- **Cost:** effectively free at single-user scale. PAY_PER_REQUEST DynamoDB, infrequent Lambda invocations, CloudFront edge cache. Real-world < $1/month.

See [CLAUDE.md](./CLAUDE.md) for the maintainer-facing architecture notes.

---

## What's shipped

- ✅ Sprints with name / description / retrospective
- ✅ Burndown chart with PACE metric
- ✅ All-Sprints history view
- ✅ Two-week default, configurable per-sprint
- ✅ Planning state — first sprint's start date floats until first entry
- ✅ Day-by-day entry browsing
- ✅ Lambda@Edge auth (cookie + unlock URL)
- ✅ DynamoDB point-in-time recovery, S3 versioning, CloudWatch retention
- ✅ CloudFront security headers (HSTS, CSP, X-Frame-Options)
- ✅ iOS-zoom-safe input sizing, ≥44 px touch targets, accessibility labels
- ✅ 101+ tests (front-end + lambda scoring + lambda helpers)
- ✅ GitHub Actions CI/CD on tag push

## Roadmap

- **Domain change** — registering `habitagility.com` (or `.io` / `.app`) and cutting DNS over.
- **CloudWatch alarms** — SNS-to-email on Lambda errors / DDB throttles.
- **Cross-region export deadlock fix** — current Lambda@Edge token rotation can stall the `CrossRegionExportWriter` custom resource; need either a Lambda-alias migration or a 2-step workflow.
- **Habit reorder** — drag-and-drop within a category.
- **Custom category accent colors** — picker UI.
- **Front-end render tests** — jsdom + vitest coverage for the UI modules.

---

## Repository layout

| Path | Purpose |
|---|---|
| `app/tracker.html` | Web app shell |
| `app/scripts/` | ES modules (`core`, `sync`, `handlers`, `entry-ui`, `trends-ui`, `plan-ui`, `scoring`, `constants`, `types`) |
| `app/styles/tracker.css` | Single stylesheet (CSS variables, mobile-first dark theme) |
| `infrastructure/` | AWS CDK app — cert + main stack, sync + auth lambdas |
| `tests/` | Vitest unit tests (front-end scoring, lambda helpers, lambda utils) |
| `scripts/backup.ps1`, `scripts/backup.sh` | Per-item REST backup to timestamped JSON |
| `.github/workflows/` | CI (lint + test + synth) and deploy (tag-triggered) |
| `.claude/settings.json` | Project-scoped Claude Code settings (denies local `cdk deploy`) |

---

## Status

This is a **personal-use** product hosted on the maintainer's own AWS account. It's not a SaaS, doesn't accept signups, and has no shared backend. The repo exists so you can **fork it and run your own**. If you want to do that and run into something confusing, open an issue.

**License:** [MIT](./LICENSE) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Security:** [SECURITY.md](./SECURITY.md) · **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md) · **Maintainer notes:** [CLAUDE.md](./CLAUDE.md)
