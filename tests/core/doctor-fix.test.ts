import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DoctorFixDeps,
  type FixItem,
  applyDoctorFixes,
  classifyReversible,
  defaultDoctorFixDeps,
  planInstructionFixes,
} from '~/core/doctor-fix';
import { checkInstructionsForHosts } from '~/core/instruction-bridge';
import { ALLOW_RULE } from '~/core/settings-allowlist';

function baseDeps(over: Partial<DoctorFixDeps> = {}): { deps: DoctorFixDeps; confirms: string[] } {
  const confirms: string[] = [];
  const deps: DoctorFixDeps = {
    repoRoot: '/repo',
    confirmNonReversible: async (item) => {
      confirms.push(item.targetPath);
      return false; // non-TTY default: do not apply
    },
    syncProjection: async () => ({ applied: true, backupPath: '/repo/CLAUDE.md.ditto_bak' }),
    ensureAllowlist: async () => ({ applied: true }),
    ...over,
  };
  return { deps, confirms };
}

describe('classifyReversible', () => {
  test('project-level paths are reversible', () => {
    expect(classifyReversible('/repo/CLAUDE.md', '/home/u')).toBe(true);
    expect(classifyReversible('/repo/.claude/settings.json', '/home/u')).toBe(true);
  });

  test('global ~/.claude paths are non-reversible (ADR-0011 host impact)', () => {
    expect(classifyReversible('/home/u/.claude/CLAUDE.md', '/home/u')).toBe(false);
  });
});

describe('planInstructionFixes', () => {
  test('maps a drift finding to a reversible instruction-projection fix', () => {
    const items = planInstructionFixes(
      [{ host: 'claude-code', path: '/repo/CLAUDE.md', kind: 'sha256_mismatch', message: 'm' }],
      '/home/u',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'instruction-projection', reversible: true });
  });

  test('no findings = no fixes', () => {
    expect(planInstructionFixes([], '/home/u')).toEqual([]);
  });
});

describe('applyDoctorFixes', () => {
  test('reversible items auto-apply without confirm', async () => {
    const { deps, confirms } = baseDeps();
    const items: FixItem[] = [
      {
        kind: 'instruction-projection',
        reversible: true,
        targetPath: '/repo/CLAUDE.md',
        describe: 'CLAUDE.md drift',
      },
    ];
    const result = await applyDoctorFixes(deps, items);
    expect(confirms).toEqual([]); // never asked
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  test('non-reversible items are skipped in non-TTY (confirm returns false), exit-safe', async () => {
    const { deps, confirms } = baseDeps();
    const items: FixItem[] = [
      {
        kind: 'instruction-projection',
        reversible: false,
        targetPath: '/home/u/.claude/CLAUDE.md',
        describe: 'global drift',
      },
    ];
    const result = await applyDoctorFixes(deps, items);
    expect(confirms).toEqual(['/home/u/.claude/CLAUDE.md']);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  test('non-reversible items apply when confirm returns true (TTY yes)', async () => {
    const { deps } = baseDeps({ confirmNonReversible: async () => true });
    const items: FixItem[] = [
      {
        kind: 'instruction-projection',
        reversible: false,
        targetPath: '/home/u/.claude/CLAUDE.md',
        describe: 'global drift',
      },
    ];
    const result = await applyDoctorFixes(deps, items);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  test('zero fixable items = nothing-to-fix no-op', async () => {
    const { deps } = baseDeps();
    const result = await applyDoctorFixes(deps, []);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.nothingToFix).toBe(true);
  });
});

describe('syncProjection repair (real fs, .bak via writeBackupOnce)', () => {
  test('re-projects managed block and backs up the original once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-docfix-'));
    try {
      await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\nfresh instruction\n', 'utf8');
      // stale managed block + preserved free text
      await writeFile(
        join(dir, 'CLAUDE.md'),
        'keep me\n<!-- ditto:managed:start source=AGENTS.md sha256=0000000000000000000000000000000000000000000000000000000000000000 -->\nstale\n<!-- ditto:managed:end -->\n',
        'utf8',
      );
      const before = await checkInstructionsForHosts(['claude-code'], dir);
      expect(before.findings.length).toBeGreaterThan(0);

      const { defaultDoctorFixDeps } = await import('~/core/doctor-fix');
      const deps = defaultDoctorFixDeps(dir, '/home/nobody');
      const res = await deps.syncProjection();
      expect(res.applied).toBe(true);
      expect(res.backupPath).toBe(join(dir, 'CLAUDE.md.ditto_bak'));

      const after = await checkInstructionsForHosts(['claude-code'], dir);
      expect(after.findings).toEqual([]);
      const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
      expect(text).toContain('keep me'); // content outside block preserved
      const bak = await readFile(join(dir, 'CLAUDE.md.ditto_bak'), 'utf8');
      expect(bak).toContain('stale'); // first original kept

      // idempotent: re-run does not overwrite the .bak
      await deps.syncProjection();
      const bak2 = await readFile(join(dir, 'CLAUDE.md.ditto_bak'), 'utf8');
      expect(bak2).toContain('stale');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureAllowlist repair (real fs)', () => {
  test('adds ditto allow rule idempotently, preserves other rules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-docfix-allow-'));
    try {
      const settingsPath = join(dir, '.claude', 'settings.json');
      const { defaultDoctorFixDeps } = await import('~/core/doctor-fix');
      const deps = defaultDoctorFixDeps(dir, '/home/nobody');
      // pre-existing unrelated rule
      await writeFile(
        join(dir, 'settings-seed.json'),
        JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }),
        'utf8',
      );
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2),
        'utf8',
      );
      await deps.ensureAllowlist();
      const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
      expect(parsed.permissions.allow).toContain(ALLOW_RULE);
      expect(parsed.permissions.allow).toContain('Bash(ls:*)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ac-3 caveat closer: the unit tests above prove the *logic* (global→non-reversible,
// confirm=false→skip) with mock deps. This closes the last weak link — a real
// non-reversible FixItem run through the REAL effectful deps on a REAL filesystem,
// asserting the global gate actually withholds the mutation. The "global" home dir
// is an injected tmpdir (defaultDoctorFixDeps/classifyReversible take homeDir), so
// no real ~/.claude is touched.
describe('non-reversible repair end-to-end on real fs (ac-3 live mutation-skip)', () => {
  const STALE =
    'keep me\n<!-- ditto:managed:start source=AGENTS.md sha256=0000000000000000000000000000000000000000000000000000000000000000 -->\nstale\n<!-- ditto:managed:end -->\n';

  async function exists(path: string): Promise<boolean> {
    try {
      await readFile(path, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  test('global ~/.claude target: non-TTY skip leaves the real repo file untouched, no .bak', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-docfix-irrev-'));
    const home = await mkdtemp(join(tmpdir(), 'ditto-docfix-home-'));
    try {
      // Real drift in the repo: if syncProjection ran, CLAUDE.md would be re-projected.
      await writeFile(join(repoRoot, 'AGENTS.md'), '# AGENTS\nfresh instruction\n', 'utf8');
      await writeFile(join(repoRoot, 'CLAUDE.md'), STALE, 'utf8');

      // A drift finding whose projection path is the GLOBAL ~/.claude file → non-reversible.
      const globalPath = join(home, '.claude', 'CLAUDE.md');
      const items = planInstructionFixes(
        [{ host: 'claude-code', path: globalPath, kind: 'sha256_mismatch', message: 'm' }],
        home,
      );
      expect(items).toHaveLength(1);
      expect(items[0]?.reversible).toBe(false); // global → non-reversible

      // Real deps, default non-TTY confirm (false) → must skip, never run syncProjection.
      const deps = defaultDoctorFixDeps(repoRoot, home);
      const result = await applyDoctorFixes(deps, items);
      expect(result.skipped).toHaveLength(1);
      expect(result.applied).toHaveLength(0);

      // The real repo file is byte-identical (syncProjection never ran) and no backup written.
      expect(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).toBe(STALE);
      expect(await exists(join(repoRoot, 'CLAUDE.md.ditto_bak'))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test('control: a TTY confirm (true) lets the same non-reversible item apply on real fs', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-docfix-irrev-ok-'));
    const home = await mkdtemp(join(tmpdir(), 'ditto-docfix-home-ok-'));
    try {
      await writeFile(join(repoRoot, 'AGENTS.md'), '# AGENTS\nfresh instruction\n', 'utf8');
      await writeFile(join(repoRoot, 'CLAUDE.md'), STALE, 'utf8');
      const globalPath = join(home, '.claude', 'CLAUDE.md');
      const items = planInstructionFixes(
        [{ host: 'claude-code', path: globalPath, kind: 'sha256_mismatch', message: 'm' }],
        home,
      );
      expect(items[0]?.reversible).toBe(false);

      // Same real deps, but confirm=true (TTY yes) → the gate opens and the repair runs.
      const deps = {
        ...defaultDoctorFixDeps(repoRoot, home),
        confirmNonReversible: async () => true,
      };
      const result = await applyDoctorFixes(deps, items);
      expect(result.applied).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);

      // Proof the gate, not a no-op dep, was the difference: the managed block is now
      // re-projected (drift cleared) and the original was backed up once.
      const after = await checkInstructionsForHosts(['claude-code'], repoRoot);
      expect(after.findings).toEqual([]);
      expect(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).toContain('keep me');
      expect(await readFile(join(repoRoot, 'CLAUDE.md.ditto_bak'), 'utf8')).toContain('stale');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
