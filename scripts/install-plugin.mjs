#!/usr/bin/env node
// DITTO install orchestrator (cross-platform). Pure Node — no external deps.
//
// 닭-달걀 경계: wizard(`ditto setup`)는 `ditto` 바이너리 자체이므로, 바이너리가 없는 신규
// 사용자에겐 이 부트스트랩이 먼저 필요하다. 그래서 이 스크립트는 **부트스트랩만** 한다:
//   1. build   `bun run build:plugin` → <repo>/dist/plugin/ (bin/ditto 포함, 배포 단위)
//   2. place   바이너리를 PATH(~/.local/bin)에 심링크 → 이후 `ditto …`가 해석됨
//
// 그 위의 프로젝트 단계(host 블록·.ditto scaffold·allowlist·CodeQL/Playwright/LSP 설치)는
// 전부 빌드된 바이너리에 위임한다:
//   install   → `ditto setup --dir <target> --yes --tools`
//   uninstall → `ditto teardown --dir <target>`  (+ 바이너리 unplace)
//   status    → 바이너리 부트스트랩 사실 보고 + `ditto doctor` 안내
//
// 이렇게 해서 설치 로직의 단일 진실원은 TS(src/core/provision/*, ditto setup)이고, 예전처럼
// 이 .mjs가 CodeQL/Playwright/allowlist 탐지·설치를 리터럴로 복제하던 손동기화가 사라진다.
//
// Env: DITTO_HOME  absolute path to the ditto repo (auto-detected if unset)

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = platform() === 'win32';

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { mode: 'install', target: null, build: true, tools: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--no-build') out.build = false;
    else if (a === '--no-tools') out.tools = false;
    else positional.push(a);
  }
  if (positional[0]) out.mode = positional[0];
  return out;
}

// ------------------------------------------------------------------ repo/target
function resolveRepo() {
  const envHome = process.env.DITTO_HOME;
  if (envHome && existsSync(join(envHome, '.claude-plugin', 'plugin.json'))) {
    return resolve(envHome);
  }
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts/
  const guess = resolve(here, '..');
  if (existsSync(join(guess, '.claude-plugin', 'plugin.json'))) return guess;
  throw new Error(
    'Could not locate DITTO repo. Set DITTO_HOME to the repo root (containing .claude-plugin/plugin.json).',
  );
}

/** target. selfHost(target===repo)면 `ditto setup`가 자체 self-host no-op으로 처리한다. */
function resolveTarget(repo, targetArg) {
  const target = resolve(targetArg ?? process.cwd());
  return { target, selfHost: target === repo };
}

// ------------------------------------------------------------------ (1) build
function binaryPath(repo) {
  return join(repo, 'dist', 'plugin', 'bin', IS_WIN ? 'ditto.exe' : 'ditto');
}
function buildBinary(repo) {
  const r = spawnSync('bun', ['run', 'build:plugin'], { cwd: repo, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, message: 'bun not found on PATH — install bun ≥1.3 then re-run' };
  }
  if (r.status !== 0) return { ok: false, message: `build failed (exit ${r.status})` };
  return { ok: existsSync(binaryPath(repo)), message: binaryPath(repo) };
}

// ------------------------------------------------------------------ (2) place
function placeDir() {
  return join(homedir(), '.local', 'bin');
}
function linksTo(linkPath, binary) {
  try {
    return (
      lstatSync(linkPath).isSymbolicLink() && resolve(readlinkSync(linkPath)) === resolve(binary)
    );
  } catch {
    return false;
  }
}
function lstatSafe(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
function placeBinary(repo) {
  const binary = binaryPath(repo);
  if (!existsSync(binary)) return { ok: false, message: 'binary not built; skipped placement' };
  if (IS_WIN) {
    return {
      ok: false,
      message: `add ${dirname(binary)} to PATH so \`ditto\` resolves (symlink placement is POSIX-only)`,
    };
  }
  const dir = placeDir();
  const link = join(dir, 'ditto');
  if (linksTo(link, binary)) return { ok: true, message: `${link} (already linked)` };
  if (lstatSafe(link)) {
    return {
      ok: false,
      message: `${link} exists and is not ours; remove it or adjust PATH manually`,
    };
  }
  mkdirSync(dir, { recursive: true });
  symlinkSync(binary, link);
  return { ok: true, message: link };
}
function unplaceBinary(repo) {
  const link = join(placeDir(), 'ditto');
  if (linksTo(link, binaryPath(repo))) {
    rmSync(link);
    return { ok: true, message: `removed ${link}` };
  }
  return { ok: false, message: `left ${link} (not ours or absent)` };
}

// --------------------------------------------------- (3) delegate to the binary
/** 빌드된 바이너리로 프로젝트 단계를 위임 실행한다. */
function delegate(repo, args) {
  const binary = binaryPath(repo);
  if (!existsSync(binary)) return { ok: false, message: 'binary not built; cannot delegate' };
  const r = spawnSync(binary, args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, message: 'binary not executable' };
  if (r.status !== 0) {
    return { ok: false, message: `\`ditto ${args[0]}\` failed (exit ${r.status})` };
  }
  return { ok: true, message: `ditto ${args.join(' ')}` };
}

// ----------------------------------------------------------------------- modes
function doInstall(repo, target, build, tools) {
  const log = [];

  if (build) {
    const b = buildBinary(repo);
    log.push(`build:     ${b.ok ? 'ok' : 'FAILED'} — ${b.message}`);
    if (!b.ok) {
      const err = new Error(
        `build failed — the hook/CLI binary is required for DITTO to work; aborting. Fix the cause (e.g. install bun ≥1.3) and re-run; a re-run is idempotent. (${b.message})`,
      );
      err.partialLog = log;
      throw err;
    }
  } else {
    log.push('build:     skipped (--no-build)');
  }

  const p = placeBinary(repo);
  log.push(`place:     ${p.ok ? 'ok' : 'SKIPPED'} — ${p.message}`);

  // 프로젝트 단계 전부를 `ditto setup`에 위임(host 블록·scaffold·allowlist·도구 설치).
  // self-host는 setup가 no-op으로 처리하므로 분기 불필요.
  const setupArgs = ['setup', '--dir', target, '--yes', ...(tools ? ['--tools'] : [])];
  const s = delegate(repo, setupArgs);
  log.push(`setup:     ${s.ok ? 'ok' : 'FAILED'} — ${s.message}`);
  if (!s.ok) {
    const err = new Error(`\`ditto setup\` failed — see output above. (${s.message})`);
    err.partialLog = log;
    throw err;
  }
  return log;
}

function doUninstall(repo, target) {
  const log = [];
  const up = unplaceBinary(repo);
  log.push(`unplace:   ${up.message}`);
  // 관리 블록·allowlist 제거를 `ditto teardown`에 위임(.ditto/ 데이터는 보존).
  const t = delegate(repo, ['teardown', '--dir', target]);
  log.push(`teardown:  ${t.ok ? 'ok' : 'SKIPPED'} — ${t.message}`);
  log.push(`data:      left ${join(target, '.ditto')} intact (remove manually to purge history)`);
  return log;
}

function doStatus(repo, target) {
  const link = join(placeDir(), 'ditto');
  return {
    repo,
    target,
    binary_built: existsSync(binaryPath(repo)),
    binary_on_path: IS_WIN ? null : linksTo(link, binaryPath(repo)),
    next: 'run `ditto doctor` for project-level status (instructions/permissions/tools)',
  };
}

function main() {
  const { mode, target: targetArg, build, tools } = parseArgs(process.argv.slice(2));
  if (!['install', 'uninstall', 'status'].includes(mode)) {
    console.error(
      'usage: install-plugin.mjs [install|uninstall|status] [--target <dir>] [--no-build] [--no-tools]',
    );
    process.exit(64);
  }
  const repo = resolveRepo();
  const { target, selfHost } = resolveTarget(repo, targetArg);

  if (mode === 'status') {
    console.log(JSON.stringify(doStatus(repo, target), null, 2));
    return;
  }

  let log;
  try {
    log = mode === 'install' ? doInstall(repo, target, build, tools) : doUninstall(repo, target);
  } catch (err) {
    console.error(`[ditto] ${mode} FAILED`);
    console.error(`  repo:   ${repo}`);
    console.error(`  target: ${target}${selfHost ? ' (self-host)' : ''}`);
    for (const line of err.partialLog ?? []) console.error(`  ${line}`);
    console.error(`  error:  ${err.message}`);
    process.exit(1);
  }
  console.log(`[ditto] ${mode} OK`);
  console.log(`  repo:   ${repo}`);
  console.log(
    `  target: ${target}${selfHost ? ' (self-host — setup self-no-ops project steps)' : ''}`,
  );
  for (const line of log) console.log(`  ${line}`);

  if (mode === 'install') {
    console.log('');
    console.log('Next: load the plugin, then verify in a new session');
    console.log('  claude --plugin-dir dist/plugin   # local dev (no marketplace needed)');
    console.log('  ditto doctor                      # binary on PATH, runtime reachable');
  }
}

main();
