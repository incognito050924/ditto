/**
 * Mode doctor (WI-A) — answer "what ditto am I running, and is it current?".
 *
 * Two questions a developer kept having to reverse-engineer mid-task:
 *
 *  1. Did THIS session load the working-tree plugin (`--plugin-dir .`, "dev") or
 *     the installed plugin (the marketplace cache, "installed")? Only the harness
 *     knows — it substitutes `${CLAUDE_PLUGIN_ROOT}` into hook/skill bodies but
 *     NOT into a bare shell, so the session mode is observable only where that
 *     value is available (the SessionStart hook). A bare `ditto mode` sees `null`
 *     → `unknown`, and falls back to the staleness question below.
 *
 *  2. Is the installed plugin STALE vs the working tree, and if so what do I run?
 *     `doctor distribution`'s `binary_fresh` only compares `src/` → `bin` inside a
 *     dev checkout; the installed plugin has no `src/`, so it reads vacuously
 *     fresh even when `agents/`/`skills/` drifted (the exact failure this WI was
 *     born from). So freshness here compares TWO identity axes between installed
 *     and working tree: the src bundle stamp AND a stamp over the deployed surface
 *     (`agents/`+`skills/`+`hooks/`).
 *
 * This module is the pure verdict; the I/O collector and CLI presentation wrap it.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { computeSourceStamp, readEmbeddedStamp } from './build-stamp';

export type SessionMode = 'dev' | 'installed' | 'unknown';

/**
 * The single recommended next action, derived from the staleness verdict + git
 * state — this IS the "when do I deploy/reinstall" rule, codified so the output
 * and the docs share one source of truth.
 */
export type ModeAction = 'none' | 'install' | 'reinstall' | 'commit-push-reinstall';

export interface ModeInputs {
  /** `${CLAUDE_PLUGIN_ROOT}` for this session, or null when unobservable (bare shell). */
  pluginRoot: string | null;
  repoRoot: string;
  /** Content stamp over the working tree's `src/` bundle (computeSourceStamp). */
  repoSrcStamp: string;
  /** Content stamp over the working tree's deployed surface (agents/+skills/+hooks/). */
  repoSurfaceStamp: string;
  installedPresent: boolean;
  installedVersion: string | null;
  /** src stamp embedded in the installed bin; null when absent (pre-stamp / missing). */
  installedSrcStamp: string | null;
  /** Surface stamp computed over the installed plugin's agents/+skills/+hooks/. */
  installedSurfaceStamp: string | null;
  /** Working tree has uncommitted changes to tracked files. */
  repoDirty: boolean;
  /** Local repo has commits not yet on the marketplace source (origin). */
  repoAhead: boolean;
}

export interface ModeReport {
  sessionMode: SessionMode;
  installed: { present: boolean; version: string | null; fresh: boolean };
  drift: { src: boolean; surface: boolean };
  action: ModeAction;
  reason: string;
}

/** Classify which plugin copy a session loaded, from its plugin root. */
function classifySession(pluginRoot: string | null, repoRoot: string): SessionMode {
  if (pluginRoot === null) return 'unknown';
  // Installed wins over repo-containment: the cache lives under ~/.claude, so when
  // repoRoot is an ancestor (e.g. $HOME) an installed plugin still reads installed.
  if (pluginRoot.includes('/plugins/cache/')) return 'installed';
  if (pluginRoot === repoRoot || pluginRoot.startsWith(`${repoRoot}/`)) return 'dev';
  return 'unknown';
}

const ACTION_REASON: Record<ModeAction, string> = {
  none: 'installed plugin matches the working tree',
  install: 'no installed plugin found',
  reinstall: 'installed plugin is behind the pushed source — marketplace update + reinstall',
  'commit-push-reinstall':
    'the drift includes local-only work (uncommitted or unpushed) — commit+push, then reinstall (or load the working tree with --plugin-dir for a quick dogfood)',
};

/**
 * Pure verdict. Freshness requires BOTH identity axes to match; the action is the
 * deploy rule: missing → install; fresh → none; drift with local-only work →
 * commit-push-reinstall; drift that is already pushed → reinstall.
 */
export function resolveMode(inp: ModeInputs): ModeReport {
  const sessionMode = classifySession(inp.pluginRoot, inp.repoRoot);
  const driftSrc = inp.installedPresent && inp.installedSrcStamp !== inp.repoSrcStamp;
  const driftSurface = inp.installedPresent && inp.installedSurfaceStamp !== inp.repoSurfaceStamp;
  const fresh = inp.installedPresent && !driftSrc && !driftSurface;

  let action: ModeAction;
  if (!inp.installedPresent) action = 'install';
  else if (fresh) action = 'none';
  else if (inp.repoDirty || inp.repoAhead) action = 'commit-push-reinstall';
  else action = 'reinstall';

  return {
    sessionMode,
    installed: { present: inp.installedPresent, version: inp.installedVersion, fresh },
    drift: { src: driftSrc, surface: driftSurface },
    action,
    reason: ACTION_REASON[action],
  };
}

export interface ModeBanner {
  /** Loud (the stale-installed footgun) vs quiet info. */
  warn: boolean;
  /** Banner to inject at session start; empty string = show nothing. */
  text: string;
}

const DOGFOOD_HINT = 'bun run dogfood';

/**
 * The SessionStart guard (WI-A): the moment a session opens INSIDE the ditto repo,
 * say which plugin it loaded so a plain session on the stale installed plugin — the
 * exact footgun this work was born from — never goes unnoticed. Silent outside the
 * ditto source repo (a normal project using npx ditto has nothing to warn about).
 */
export function formatModeBanner(report: ModeReport, opts: { inDittoRepo: boolean }): ModeBanner {
  if (!opts.inDittoRepo) return { warn: false, text: '' };
  // Reworded to plain Korean (wi_260713nlg), keeping every operative cue: the
  // dogfood-mode confirmation, the STALE warning ("here edits do NOT take
  // effect"), and — the load-bearing instruction — EXIT and RE-ENTER with
  // `bun run dogfood [--host codex]`. Commands stay literal.
  if (report.sessionMode === 'dev') {
    return {
      warn: false,
      text: '✓ ditto dogfood 모드 — 이 세션은 작업 트리(working tree) 빌드로 돈다.',
    };
  }
  if (report.sessionMode === 'installed') {
    const v = report.installed.version ?? '?';
    if (!report.installed.fresh) {
      return {
        warn: true,
        text: `⚠ ditto: 이 세션은 설치된(INSTALLED) 플러그인(v${v})을 불러왔고, 작업 트리보다 오래됐다(STALE) — 여기서 한 편집은 반영되지 않는다. ditto를 개발하려면 세션을 나갔다가 이 명령으로 다시 들어오라: ${DOGFOOD_HINT} [--host codex]`,
      };
    }
    return {
      warn: false,
      text: `ditto: 이 세션은 설치된 플러그인(v${v})을 불러왔다. ditto를 실시간으로 편집하려면 이 명령으로 들어오라: ${DOGFOOD_HINT} [--host codex]`,
    };
  }
  return { warn: false, text: '' };
}

/**
 * The `ditto mode` readout — the active (on-demand) form of the SessionStart
 * banner. A bare shell can't observe THIS session's plugin root (sessionMode is
 * usually `unknown`), but the staleness verdict + deploy action are always
 * answerable, so the command stays useful from any terminal. Outside the ditto
 * source repo staleness is meaningless → collapse to a single line.
 */
export function formatModeHuman(report: ModeReport, inDittoRepo: boolean): string[] {
  if (!inDittoRepo) {
    return [
      `ditto mode: session=${report.sessionMode} (not the ditto source repo — no staleness check)`,
    ];
  }
  const inst = report.installed.present
    ? `present v${report.installed.version ?? '?'}, ${report.installed.fresh ? 'fresh' : 'STALE'}`
    : 'absent';
  return [
    'ditto mode',
    `  session:   ${report.sessionMode}`,
    `  installed: ${inst}`,
    `  drift:     src=${report.drift.src ? 'yes' : 'no'} surface=${report.drift.surface ? 'yes' : 'no'}`,
    `  action:    ${report.action} — ${report.reason}`,
  ];
}

// ── I/O collector ───────────────────────────────────────────────────────────
// Resolves the ModeInputs from the runtime (installed cache, working tree, git).

/** Surface = the deployed definition dirs the src-stamp does NOT cover. */
const SURFACE_DIRS = ['agents', 'skills', 'hooks'];

function listSurfaceFiles(root: string, rel: string, out: string[]): void {
  const dir = join(root, rel);
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) listSurfaceFiles(root, childRel, out);
    else if (e.isFile()) out.push(childRel);
  }
}

/**
 * Content stamp over the deployed surface (agents/+skills/+hooks/). The src-stamp
 * only hashes `.ts` under `src/`, so an `agents/*.md` drift (the failure this was
 * born from) is invisible to it; this closes that blind spot.
 */
export function computeSurfaceStamp(root: string): string {
  const files: string[] = [];
  for (const d of SURFACE_DIRS) listSurfaceFiles(root, d, files);
  files.sort();
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update(' ');
    h.update(readFileSync(join(root, rel)));
    h.update(' ');
  }
  return h.digest('hex');
}

/** True only inside ditto's own source repo (not a project that npx-installed ditto). */
export function isDittoSourceRepo(repoRoot: string): boolean {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown };
    return pkg.name === 'ditto' && existsSync(join(repoRoot, 'src', 'cli', 'index.ts'));
  } catch {
    return false;
  }
}

/**
 * The session's plugin root. `${CLAUDE_PLUGIN_ROOT}` reaches a hook either as env
 * or — always — as the running bin path (`<pluginRoot>/bin/ditto`), so derive it
 * from argv when the env is absent.
 */
export function resolvePluginRoot(
  env: Record<string, string | undefined>,
  argv1: string | undefined,
): string | null {
  if (env.CLAUDE_PLUGIN_ROOT) return env.CLAUDE_PLUGIN_ROOT;
  if (argv1 === undefined) return null;
  if (argv1.replace(/\\/g, '/').endsWith('/bin/ditto')) {
    return resolve(dirname(argv1), '..');
  }
  return null;
}

function readInstalledIdentity(home: string) {
  const base = join(home, '.claude', 'plugins', 'cache', 'ditto-local', 'ditto');
  const absent = { present: false, version: null, srcStamp: null, surfaceStamp: null };
  if (!existsSync(base)) return absent;
  const versions = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort();
  const version = versions[versions.length - 1]; // highest version dir = what a fresh session loads
  if (!version) return absent;
  const dir = join(base, version);
  let srcStamp: string | null = null;
  try {
    srcStamp = readEmbeddedStamp(readFileSync(join(dir, 'bin', 'ditto'), 'utf8'));
  } catch {
    srcStamp = null;
  }
  const surfaceStamp = existsSync(dir) ? computeSurfaceStamp(dir) : null;
  return { present: true, version, srcStamp, surfaceStamp };
}

function gitState(repoRoot: string): { dirty: boolean; ahead: boolean } {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = (status.stdout ?? '').trim().length > 0;
  const rev = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const ahead = rev.status === 0 && Number.parseInt((rev.stdout ?? '0').trim(), 10) > 0;
  return { dirty, ahead };
}

export interface CollectModeOpts {
  env?: Record<string, string | undefined>;
  argv1?: string;
  home?: string;
}

/** Assemble ModeInputs from the runtime and resolve the verdict + repo context. */
export function collectModeReport(
  repoRoot: string,
  opts: CollectModeOpts = {},
): { report: ModeReport; inDittoRepo: boolean } {
  const env = opts.env ?? process.env;
  const argv1 = opts.argv1 ?? process.argv[1];
  const home = opts.home ?? homedir();
  const pluginRoot = resolvePluginRoot(env, argv1);
  const inDittoRepo = isDittoSourceRepo(repoRoot);
  if (!inDittoRepo) {
    // Outside the source repo, staleness is meaningless — classify the session only.
    return {
      inDittoRepo: false,
      report: resolveMode({
        pluginRoot,
        repoRoot,
        repoSrcStamp: '',
        repoSurfaceStamp: '',
        installedPresent: false,
        installedVersion: null,
        installedSrcStamp: null,
        installedSurfaceStamp: null,
        repoDirty: false,
        repoAhead: false,
      }),
    };
  }
  const installed = readInstalledIdentity(home);
  const git = gitState(repoRoot);
  return {
    inDittoRepo: true,
    report: resolveMode({
      pluginRoot,
      repoRoot,
      repoSrcStamp: computeSourceStamp(repoRoot),
      repoSurfaceStamp: computeSurfaceStamp(repoRoot),
      installedPresent: installed.present,
      installedVersion: installed.version,
      installedSrcStamp: installed.srcStamp,
      installedSurfaceStamp: installed.surfaceStamp,
      repoDirty: git.dirty,
      repoAhead: git.ahead,
    }),
  };
}
