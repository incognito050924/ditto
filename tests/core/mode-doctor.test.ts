import { describe, expect, test } from 'bun:test';
import {
  type ModeInputs,
  type ModeReport,
  formatModeBanner,
  resolveMode,
} from '~/core/mode-doctor';

// A baseline where the installed plugin exactly matches the working tree on both
// identity axes (src bundle + deployed surface) and git is clean+pushed.
const FRESH: ModeInputs = {
  pluginRoot: null,
  repoRoot: '/repo',
  repoSrcStamp: 'SRC',
  repoSurfaceStamp: 'SURF',
  installedPresent: true,
  installedVersion: '0.1.0',
  installedSrcStamp: 'SRC',
  installedSurfaceStamp: 'SURF',
  repoDirty: false,
  repoAhead: false,
};

describe('resolveMode — installed staleness verdict (the deploy criteria, codified)', () => {
  test('matching stamps → fresh, action none', () => {
    const r = resolveMode(FRESH);
    expect(r.installed.fresh).toBe(true);
    expect(r.drift).toEqual({ src: false, surface: false });
    expect(r.action).toBe('none');
  });

  test('installed missing → action install', () => {
    const r = resolveMode({
      ...FRESH,
      installedPresent: false,
      installedVersion: null,
      installedSrcStamp: null,
      installedSurfaceStamp: null,
    });
    expect(r.installed.present).toBe(false);
    expect(r.action).toBe('install');
  });

  // The exact failure this work item was born from: agents/*.md drifted but src/
  // was unchanged. src-stamp alone (doctor distribution) misses it; the surface
  // stamp catches it.
  test('surface drift only, repo clean+pushed → reinstall', () => {
    const r = resolveMode({ ...FRESH, installedSurfaceStamp: 'OLD' });
    expect(r.drift).toEqual({ src: false, surface: true });
    expect(r.installed.fresh).toBe(false);
    expect(r.action).toBe('reinstall');
  });

  test('src drift while repo has unpushed commits → commit-push-reinstall', () => {
    const r = resolveMode({ ...FRESH, installedSrcStamp: 'OLD', repoAhead: true });
    expect(r.drift.src).toBe(true);
    expect(r.action).toBe('commit-push-reinstall');
  });

  test('surface drift while working tree dirty → commit-push-reinstall', () => {
    const r = resolveMode({ ...FRESH, installedSurfaceStamp: 'OLD', repoDirty: true });
    expect(r.action).toBe('commit-push-reinstall');
  });

  // A present binary with no embedded stamp (pre-stamp build) is stale, not fresh.
  test('installed present but no embedded src stamp → src drift', () => {
    const r = resolveMode({ ...FRESH, installedSrcStamp: null });
    expect(r.drift.src).toBe(true);
    expect(r.installed.fresh).toBe(false);
  });
});

describe('resolveMode — session mode classification (which copy THIS session loaded)', () => {
  test('pluginRoot inside repo → dev (working-tree dogfood)', () => {
    expect(resolveMode({ ...FRESH, pluginRoot: '/repo' }).sessionMode).toBe('dev');
    expect(resolveMode({ ...FRESH, pluginRoot: '/repo/dist/plugin' }).sessionMode).toBe('dev');
  });

  test('pluginRoot in install cache → installed', () => {
    expect(
      resolveMode({
        ...FRESH,
        pluginRoot: '/home/u/.claude/plugins/cache/ditto-local/ditto/0.1.0',
      }).sessionMode,
    ).toBe('installed');
  });

  test('pluginRoot null (bare shell can not see it) → unknown', () => {
    expect(resolveMode(FRESH).sessionMode).toBe('unknown');
  });

  // The install cache lives under ~/.claude; if repoRoot is an ancestor (e.g. $HOME),
  // an installed plugin must NOT be misread as a working-tree (dev) load.
  test('cache path that also sits under repoRoot → installed, not dev', () => {
    expect(
      resolveMode({
        ...FRESH,
        repoRoot: '/home/u',
        pluginRoot: '/home/u/.claude/plugins/cache/ditto-local/ditto/0.1.0',
      }).sessionMode,
    ).toBe('installed');
  });
});

function reportWith(over: Partial<ModeReport>): ModeReport {
  return {
    sessionMode: 'installed',
    installed: { present: true, version: '0.1.0', fresh: true },
    drift: { src: false, surface: false },
    action: 'none',
    reason: '',
    ...over,
  };
}

describe('formatModeBanner — the SessionStart entry guard', () => {
  test('dev session → no warn, confirms the working-tree build', () => {
    const b = formatModeBanner(reportWith({ sessionMode: 'dev' }), { inDittoRepo: true });
    expect(b.warn).toBe(false);
    expect(b.text.toLowerCase()).toContain('dogfood');
  });

  // The exact bug: a plain session in the ditto repo on a STALE installed plugin.
  test('ditto repo + installed + stale → warn loud, points to `bun run dogfood`', () => {
    const b = formatModeBanner(
      reportWith({
        sessionMode: 'installed',
        installed: { present: true, version: '0.1.0', fresh: false },
      }),
      { inDittoRepo: true },
    );
    expect(b.warn).toBe(true);
    expect(b.text).toContain('bun run dogfood');
    expect(b.text.toLowerCase()).toContain('stale');
  });

  test('ditto repo + installed + fresh → info (not loud), still advises dogfood', () => {
    const b = formatModeBanner(
      reportWith({
        sessionMode: 'installed',
        installed: { present: true, version: '0.1.0', fresh: true },
      }),
      { inDittoRepo: true },
    );
    expect(b.warn).toBe(false);
    expect(b.text).toContain('bun run dogfood');
  });

  test('not the ditto repo (a normal project using npx ditto) → silent', () => {
    const b = formatModeBanner(reportWith({ sessionMode: 'installed' }), { inDittoRepo: false });
    expect(b.text).toBe('');
  });

  test('dev classification but not the ditto repo → silent (no false dogfood banner)', () => {
    const b = formatModeBanner(reportWith({ sessionMode: 'dev' }), { inDittoRepo: false });
    expect(b.text).toBe('');
  });
});
