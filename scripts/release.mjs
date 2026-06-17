#!/usr/bin/env node
// DITTO release cutter. Manages the distribution (release) version in lockstep
// across every manifest the host and CLI read, rebuilds the committed bundle, and
// tags the release. There is no GitHub-Release-asset channel — the Claude Code
// plugin marketplace serves files from the repo tree only (no external-asset
// fetch), so the committed ~1.4MB JS bundle IS the distribution artifact and the
// `version` field is what drives `/plugin update`.
//
// Usage:
//   node scripts/release.mjs <major|minor|patch|X.Y.Z> [--dry-run] [--no-git]
//
// What it does (in order):
//   1. read current version from package.json, compute the next semver
//   2. write that version into all 4 touchpoints (surgical regex, no reformat):
//        package.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json,
//        src/cli/index.ts (the CLI `--version`)
//   3. rebuild the committed bundle (`bun run build:bin`) so bin/ditto carries
//      the new --version + a fresh source stamp, and emit bin/ditto.cmd
//   4. commit ONLY those files + tag `vX.Y.Z` (never pushes — that stays manual)
//
// --dry-run prints the plan and writes nothing. --no-git writes + builds but skips
// the commit/tag (e.g. to inspect the diff first).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// Each touchpoint: file + a regex whose 2nd capture group is the version string.
const TOUCHPOINTS = [
  { file: 'package.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: '.claude-plugin/plugin.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: '.codex-plugin/plugin.json', re: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'src/cli/index.ts', re: /(version:\s*')(\d+\.\d+\.\d+)(')/ },
];

function fail(msg) {
  console.error(`[ditto] release FAILED — ${msg}`);
  process.exit(1);
}

function readVersion() {
  const pkg = readFileSync(join(REPO, 'package.json'), 'utf8');
  const m = SEMVER.exec(JSON.parse(pkg).version ?? '');
  if (!m) fail(`package.json version is not semver: ${JSON.parse(pkg).version}`);
  return m;
}

function nextVersion(curMatch, bump) {
  const [major, minor, patch] = [+curMatch[1], +curMatch[2], +curMatch[3]];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (SEMVER.test(bump)) return bump;
  fail(`invalid bump '${bump}' — expected major|minor|patch|X.Y.Z`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
  if (r.error) fail(`${cmd} not runnable — ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const noGit = argv.includes('--no-git');
  const bump = argv.find((a) => !a.startsWith('--'));
  if (!bump)
    fail('missing bump — usage: release.mjs <major|minor|patch|X.Y.Z> [--dry-run] [--no-git]');

  const cur = readVersion();
  const next = nextVersion(cur, bump);
  const curStr = `${cur[1]}.${cur[2]}.${cur[3]}`;
  console.log(`[ditto] release ${curStr} → ${next}${dryRun ? ' (dry-run)' : ''}`);

  // Verify every touchpoint currently holds the same current version (drift guard).
  for (const { file, re } of TOUCHPOINTS) {
    const text = readFileSync(join(REPO, file), 'utf8');
    const m = re.exec(text);
    if (!m) fail(`no version match in ${file} (pattern drift?)`);
    if (m[2] !== curStr) fail(`${file} version ${m[2]} ≠ package.json ${curStr} — fix drift first`);
    console.log(`  ${file}: ${m[2]} → ${next}`);
  }
  if (dryRun) {
    console.log(
      `  would: build:bin, commit ${TOUCHPOINTS.length} files + bin/ditto(.cmd), tag v${next}`,
    );
    return;
  }

  for (const { file, re } of TOUCHPOINTS) {
    const text = readFileSync(join(REPO, file), 'utf8');
    writeFileSync(join(REPO, file), text.replace(re, `$1${next}$3`));
  }
  run('bun', ['run', 'build:bin']); // refresh committed bundle + bin/ditto.cmd

  if (noGit) {
    console.log(`[ditto] release ${next} staged (no git). Review, then commit + tag v${next}.`);
    return;
  }
  const files = [...TOUCHPOINTS.map((t) => t.file), 'bin/ditto', 'bin/ditto.cmd'];
  run('git', ['add', ...files]);
  run('git', ['commit', '-m', `release: v${next}`]);
  run('git', ['tag', `v${next}`]);
  console.log(`[ditto] released v${next} (committed + tagged, NOT pushed).`);
  console.log(`  publish: git push && git push origin v${next}`);
  console.log(
    '  consumers update: `claude plugin marketplace update ditto-local` → `/plugin update`',
  );
}

main();
