# Contributing to HabitAgility

Thanks for your interest! HabitAgility is a personal-use product, but the repo
exists so you can fork it. The code is small and intentional — the contribution
guidelines below match.

## Principles

- **Single-file shell.** `app/tracker.html` is the only HTML — inline CSS/JS or
  small ES modules under `app/scripts/`. No frameworks. No CDN assets.
- **Strict per-item REST.** API endpoints under `/api/*` operate on one row at
  a time. No bulk endpoints. No DynamoDB Scans on read paths. See
  [CLAUDE.md](./CLAUDE.md) for the current route list.
- **Cloud-first.** No `localStorage` for tracker data. Boot loads exactly two
  rows; everything else is lazy.
- **Small, focused diffs.** Avoid drive-by refactors mixed into feature changes.
- **No secrets in the repo.** `UNLOCK_TOKEN` is passed only at deploy time —
  `--context unlock_token=...` or `UNLOCK_TOKEN` in the deploy script. Never
  paste real tokens in commits, issues, or PR descriptions.

## Local checks

```bash
npm ci                              # root: lint + test deps
npm run check                       # Biome (format + lint)
npm test                            # Vitest (101 tests)

cd infrastructure
npm ci
npx cdk synth --context unlock_token=ci-synth-only --quiet
```

The first `synth` against a fresh checkout may write `infrastructure/cdk.context.json`
(the `HostedZone.fromLookup` cache). That file is committed in this repo so
synth is reproducible across machines and CI.

## Deploy is CI-only

Local `cdk deploy` is **denied** by `.claude/settings.json` + a `PreToolUse`
hook (`.claude/block-local-deploy.js`). Deploys go through GitHub Actions:

```bash
git tag 0.11.1
git push origin 0.11.1
```

The `.github/workflows/deploy.yml` workflow runs `cdk deploy --all` against
the `production` environment. The required secrets are `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and `UNLOCK_TOKEN`.

If a deploy fails mid-stream and CloudFormation gets stuck in
`UPDATE_ROLLBACK_FAILED` on `ExportsWriteruswest2…`, the recovery is:

```bash
aws cloudformation continue-update-rollback \
  --stack-name HabitAgilityCert --region us-east-1 \
  --resources-to-skip ExportsWriteruswest209BD44F0A7CF058B
```

then re-run `cdk deploy --all` via CI.

## Forking and your own domain

The CDK stacks assume a Route 53 hosted zone and DNS names wired in code:

- `infrastructure/lib/cert-stack.ts` — ACM cert domain, Lambda@Edge auth asset
- `infrastructure/lib/stack.ts` — CloudFront alternate domain, Route 53 ARecord

Search the repo for `ght.vexom.io` and `vexom.io` and replace with your zone +
subdomain before deploying. (Future: parameterize via `cdk.json` context so a
fork doesn't need to edit source — see roadmap in README.)

## Adding a test

The `tests/` directory is at the repo root and contains pure-function tests
against both the front-end and the lambda. New utility helpers should land
with tests — see `tests/lambda-sprint-helpers.test.js` for the pattern (pure
helpers extracted from a handler module so the test loads without the AWS SDK
at the test runner's resolution scope).

## Maintainer notes

[CLAUDE.md](./CLAUDE.md) is the architecture + editing-conventions doc shared
between human contributors and coding agents. It records:

- The strict per-item REST contract
- DynamoDB partition design and attribute conventions
- Which AWS constructs are stable IDs and which can be renamed safely
- Token-rotation deploy procedure + recovery steps
- The "user-facing HabitAgility / infra `good-habit-tracker`" rule from before
  v0.11 (resolved in v0.11 — see CHANGELOG)
