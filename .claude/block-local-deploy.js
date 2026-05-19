#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — blocks local CDK deploys.
 *
 * Deploys must go through GitHub Actions (push a tag matching `[0-9]+.[0-9]+`
 * or `[0-9]+.[0-9]+.[0-9]+`, or run the workflow via the GitHub UI). See
 * `.github/workflows/deploy.yml`.
 *
 * Reads PreToolUse JSON from stdin, denies the call if the tool command
 * contains a CDK-deploy invocation or a wrapper deploy script reference.
 * Substring-match (not prefix) so it catches compound commands like
 * `Push-Location infrastructure; npx cdk deploy ...`.
 */

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let event;
  try {
    // Strip a leading UTF-8 BOM (PowerShell pipes add one; the real harness doesn't).
    event = JSON.parse(input.replace(/^﻿/, ''));
  } catch {
    // Don't block on parse errors — fail open, the deny rules still apply.
    return;
  }
  const cmd = String(event?.tool_input?.command || '');
  const looksLikeCdkDeploy = /\bcdk\s+deploy\b/i.test(cmd);
  const looksLikeDeployScript = /(^|[\s;&|`'"\\/])deploy\.(ps1|sh)\b/i.test(cmd);
  if (!looksLikeCdkDeploy && !looksLikeDeployScript) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          'Local CDK deploys are disabled (.claude/settings.json + block-local-deploy.js).',
          '',
          'Deploys must run through GitHub Actions. Either:',
          '  1. Push a version tag: `git tag 0.7 && git push origin 0.7`',
          '  2. Or trigger workflow_dispatch: GitHub → Actions → "deploy" → Run workflow',
          '',
          'If you genuinely need to bypass (rare), the user can edit .claude/settings.json themselves.',
        ].join('\n'),
      },
    }),
  );
});
