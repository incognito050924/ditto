import { describe, expect, test } from 'bun:test';
import {
  type ModeInputs,
  type ModeReport,
  formatModeBanner,
  formatModeHuman,
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

  // ── wi_260713nlg: plain-Korean reword — directive-fidelity for the SessionStart
  // banner. It is runtime instruction, so the reword keeps every operative cue:
  // the STALE warning, "edits do NOT take effect here", and the load-bearing
  // EXIT-and-RE-ENTER-with-`bun run dogfood` instruction. Commands stay literal.
  describe('plain-Korean reword (wi_260713nlg)', () => {
    test('dev banner keeps the dogfood/working-tree cue', () => {
      const b = formatModeBanner(reportWith({ sessionMode: 'dev' }), { inDittoRepo: true });
      expect(b.text).toContain('dogfood');
      expect(b.text).toContain('작업 트리'); // working tree
    });

    test('stale-installed banner keeps STALE + no-effect + exit/re-enter instruction', () => {
      const b = formatModeBanner(
        reportWith({
          sessionMode: 'installed',
          installed: { present: true, version: '0.1.0', fresh: false },
        }),
        { inDittoRepo: true },
      );
      expect(b.warn).toBe(true);
      expect(b.text).toContain('오래됐다(STALE)'); // stale vs working tree
      expect(b.text).toContain('반영되지 않는다'); // edits will NOT take effect here
      expect(b.text).toContain('세션을 나갔다가'); // EXIT
      expect(b.text).toContain('다시 들어오라'); // RE-ENTER
      expect(b.text).toContain('bun run dogfood'); // the concrete command
      expect(b.text).toContain('--host codex');
      expect(b.text).toContain('v0.1.0'); // installed version cue
    });

    test('fresh-installed banner still advises live-edit entry via bun run dogfood', () => {
      const b = formatModeBanner(
        reportWith({
          sessionMode: 'installed',
          installed: { present: true, version: '0.1.0', fresh: true },
        }),
        { inDittoRepo: true },
      );
      expect(b.warn).toBe(false);
      expect(b.text).toContain('실시간으로 편집'); // for live edits
      expect(b.text).toContain('bun run dogfood');
    });
  });
});

describe('formatModeHuman — the `ditto mode` readout', () => {
  test('in-repo dev + fresh installed → session, installed version, action none', () => {
    const lines = formatModeHuman(
      reportWith({
        sessionMode: 'dev',
        installed: { present: true, version: '0.1.0', fresh: true },
        action: 'none',
        reason: 'installed plugin matches the working tree',
      }),
      true,
    );
    const text = lines.join('\n');
    expect(text).toContain('dev');
    expect(text).toContain('0.1.0');
    expect(text).toContain('none');
    expect(text).toContain('installed plugin matches the working tree');
  });

  test('in-repo stale installed → surfaces drift + the deploy action', () => {
    const lines = formatModeHuman(
      reportWith({
        sessionMode: 'installed',
        installed: { present: true, version: '0.1.0', fresh: false },
        drift: { src: false, surface: true },
        action: 'reinstall',
      }),
      true,
    );
    const text = lines.join('\n');
    expect(text).toContain('installed');
    expect(text).toContain('reinstall');
    expect(text).toContain('surface');
  });

  test('installed absent → action install', () => {
    const lines = formatModeHuman(
      reportWith({
        sessionMode: 'unknown',
        installed: { present: false, version: null, fresh: false },
        action: 'install',
      }),
      true,
    );
    expect(lines.join('\n')).toContain('install');
  });

  test('outside the ditto repo → one concise line, no staleness verdict', () => {
    const lines = formatModeHuman(reportWith({ sessionMode: 'unknown' }), false);
    const text = lines.join('\n');
    expect(lines.length).toBe(1);
    expect(text).not.toContain('reinstall');
  });
});
