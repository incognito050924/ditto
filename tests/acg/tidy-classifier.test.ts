import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TidyDiffStat,
  classifyTidyEntry,
  writeTidyClassification,
} from '~/acg/tidy/classifier';

const stat = (files: TidyDiffStat['files']): TidyDiffStat => ({ files });

describe('classifyTidyEntry — deterministic diff-stat gate (WU-1 ⓪)', () => {
  test('SKIP when no code files are touched (docs/config only)', () => {
    const c = classifyTidyEntry(
      stat([
        { path: 'README.md', added: 100, removed: 5, isCode: false },
        { path: 'config.json', added: 10, removed: 0, isCode: false },
      ]),
    );
    expect(c.decision).toBe('SKIP');
    expect(c.codeFiles).toBe(0);
  });

  test('SKIP when the code diff is below the smallness threshold and few files', () => {
    const c = classifyTidyEntry(stat([{ path: 'src/a.ts', added: 3, removed: 2, isCode: true }]));
    expect(c.decision).toBe('SKIP');
  });

  test('ENTER when code lines exceed the threshold', () => {
    const c = classifyTidyEntry(stat([{ path: 'src/a.ts', added: 40, removed: 10, isCode: true }]));
    expect(c.decision).toBe('ENTER');
  });

  test('ENTER when many code files are touched even if each is small', () => {
    const c = classifyTidyEntry(
      stat([
        { path: 'src/a.ts', added: 2, removed: 1, isCode: true },
        { path: 'src/b.ts', added: 2, removed: 1, isCode: true },
        { path: 'src/c.ts', added: 2, removed: 1, isCode: true },
      ]),
    );
    expect(c.decision).toBe('ENTER');
  });

  test('decision is a pure deterministic function of diff-stat with no slop input (ac-4 / OBJ-08)', () => {
    const s = stat([{ path: 'src/a.ts', added: 40, removed: 0, isCode: true }]);
    expect(classifyTidyEntry(s)).toEqual(classifyTidyEntry(s));
    // ENTER is decided by diff-stat only; the reason never cites a slop signal
    expect(classifyTidyEntry(s).reason.toLowerCase()).not.toContain('slop');
  });

  test('thresholds are overridable for conservative tuning (PM-12)', () => {
    const s = stat([{ path: 'src/a.ts', added: 10, removed: 0, isCode: true }]);
    expect(classifyTidyEntry(s, { minCodeLines: 5, minCodeFiles: 99 }).decision).toBe('ENTER');
    expect(classifyTidyEntry(s, { minCodeLines: 100, minCodeFiles: 99 }).decision).toBe('SKIP');
  });
});

describe('writeTidyClassification — decision persisted as an artifact (WU-1 ⓪ / ac-4)', () => {
  test('writes tidy-classification.json under the work item dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-tidy-'));
    try {
      const c = classifyTidyEntry(
        stat([{ path: 'src/a.ts', added: 40, removed: 0, isCode: true }]),
      );
      const p = await writeTidyClassification(dir, 'wi_test', c);
      const onDisk = JSON.parse(await readFile(p, 'utf8'));
      expect(onDisk.decision).toBe('ENTER');
      expect(p).toContain(join('work-items', 'wi_test'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
