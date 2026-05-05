# Good Habit Tracker

Mobile-first **habit tracker** (vanilla HTML/JS, no frameworks) with an **AWS CDK** stack: CloudFront, S3, Lambda@Edge (cookie / unlock-link gate), Lambda function URL, and DynamoDB. Cloud-only persistence — no `localStorage` for tracker data. Designed for personal hosting on an obscure subdomain.

**License:** [MIT](./LICENSE) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Security:** [SECURITY.md](./SECURITY.md) · **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md)

## Features

- User-defined categories and habits, points per habit, configurable cycle length (default 14 days). Per-cycle point granularity (0.1 / 0.25 / 0.5 / 1) with step-aware display precision.
- Three tabs: **Entry** (per-day check-ins), **Trends** (cycle / month / year / all-time), **Plan** (edit current or upcoming cycle).
- **Strict per-item REST API.** Boot loads exactly two rows (`GET /api/entry/:today` + `GET /api/cycle/:id`). Day navigation loads one entry at a time. Trends fetches one cycle's daily detail, one month's, or all cycle summaries — never the full table. Edits debounce per item (`PUT /api/entry/:date`, `PUT /api/cycle/:id`, `POST /api/cycle`).
- **Cycle aggregates cached in DynamoDB.** Year and all-time trends read pre-computed cycle summaries; missing summaries are lazy-filled on first view and invalidated on entry/cycle writes.
- **Server-side orphan-habit sweep:** when a habit is removed from every cycle, the lambda strips its values from every entry row (bounded to cycle ranges) and reports back so the front-end mirrors locally.
- **No DynamoDB Scans, ever.** Reads are partition-targeted `Query` and `GetItem` only.
- **Multi-user-ready storage.** Every DynamoDB key is prefixed with a `userId` (single-user today, hardcoded `main`). Adding multi-user is a one-line change in the lambda.
- **Edge-gated auth.** Lambda@Edge checks an `htok` cookie (SHA-256 of the deploy token); a one-time `?unlock=…` link sets the cookie. Sync Lambda also requires a CloudFront-injected `X-CF-Secret` header — direct Function URL calls are rejected.

## Repository layout

| Path | Purpose |
|------|---------|
| `app/tracker.html` | Web app shell (links the modules below) |
| `app/scripts/` | ES modules: `core.js`, `sync.js`, `handlers.js`, `entry-ui.js`, `trends-ui.js`, `plan-ui.js`, `main.js` |
| `app/styles/tracker.css` | Single stylesheet |
| `infrastructure/` | CDK app + `lambdas/sync` (per-item API) + `lambdas/auth` (edge gate) |
| `scripts/backup.ps1`, `backup.sh` | Hits the API, dumps cycles + entries to a timestamped JSON file in `backups/` |
| `deploy.sh` / `deploy.ps1` | `npm install` + `cdk deploy` |

## Requirements

- Node.js 18+
- AWS credentials for the target account
- Route 53 **hosted zone** for your apex domain (the sample stacks use `vexom.io` and hostname `ght.vexom.io` — change for your fork; see [CONTRIBUTING.md](./CONTRIBUTING.md))

## Deploy

Set a long random **unlock token** (deploy secret). It is hashed for Lambda@Edge; the raw token is **not** written to CloudFormation outputs. After deploy, the scripts print a one-line unlock URL.

**Bash**

```bash
export UNLOCK_TOKEN='your-long-random-secret'
# optional: export BASE_URL='https://your.hostname'   # default https://ght.vexom.io
./deploy.sh
```

**PowerShell**

```powershell
$env:UNLOCK_TOKEN = 'your-long-random-secret'
# optional: $env:BASE_URL = 'https://your.hostname'
.\deploy.ps1
```

Stacks: `GoodHabitTrackerCert` (us-east-1 — ACM + Lambda@Edge) and `GoodHabitTracker` (us-west-2 — app + API). CDK orders them by dependency. If you rotate the unlock token, see the **Lambda@Edge auth updates (export deadlock)** section in [CLAUDE.md](./CLAUDE.md).

## Backup

Before any risky change, dump the cloud state to a local JSON file:

```bash
UNLOCK_TOKEN='your-token' ./scripts/backup.sh
```
```powershell
$env:UNLOCK_TOKEN = 'your-token'; .\scripts\backup.ps1
```

Output goes to `backups/habit-tracker-YYYYMMDD-HHmmss.json`. The directory is `.gitignore`d.

## Local synth (no deploy)

```bash
cd infrastructure
npm install
npm run build
npx cdk synth --context unlock_token=dummy-token-for-synth-only
```

## Maintainer

Steven Emelander

[CLAUDE.md](./CLAUDE.md) describes schema, auth flow, and editing constraints for this repo.

## Disclaimer

This software is provided as-is. It is not a substitute for professional medical or therapeutic advice. Use and deploy at your own risk.
