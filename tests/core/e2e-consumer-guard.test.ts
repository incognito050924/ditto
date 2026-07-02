import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectImpactedJourneys } from '~/core/e2e/regression-select';

/**
 * wi_2607026qs Contract 7 — consumer fail-loud (cross-feature, ac-4).
 *
 * The v2 DSL clean break makes any v1 `.journey.md` fail parsing. The regression
 * selector MUST refuse LOUDLY: an unparsable (e.g. v1) journey has to surface in
 * `invalid_journeys` with a clear, author-actionable version-mismatch reason —
 * never be silently dropped out of impact selection (which would let the gate
 * close vacuous-green over an untested surface). A valid v2 journey is selected
 * normally alongside.
 */

let repoRoot: string;
let journeysDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-consumer-guard-'));
  journeysDir = join(repoRoot, 'e2e', 'journeys');
  await mkdir(journeysDir, { recursive: true });
  await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// A v1-era journey (pre-clean-break). Under v2 this no longer parses.
function v1JourneyDoc(id: string, name: string, surfaces: string[]): string {
  return [
    '---',
    'ditto_journey: v1',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} 보호`,
    'surfaces:',
    ...surfaces.map((s) => `  - "${s}"`),
    '---',
    '',
    '1. [s1] 무언가 한다',
    '',
  ].join('\n');
}

// A minimal valid v2 journey (ditto_journey:v2 + implementation_intent required).
function v2JourneyDoc(id: string, name: string, surfaces: string[]): string {
  return [
    '---',
    'ditto_journey: v2',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} 보호`,
    'implementation_intent: 사용자가 흐름을 완주한다',
    'surfaces:',
    ...surfaces.map((s) => `  - "${s}"`),
    '---',
    '',
    '1. [s1] 무언가 한다',
    '',
  ].join('\n');
}

describe('selectImpactedJourneys — v2 clean-break consumer guard (ac-4)', () => {
  test('v1 journey → invalid_journeys(버전 불일치 사유), v2 journey는 정상 선택', async () => {
    // Both journeys declare a component surface that intersects the changed
    // paths; if the v1 file were silently skipped its surface would vanish from
    // impact selection (vacuous-green risk). It must instead surface as invalid.
    await Bun.write(
      join(journeysDir, 'legacy.journey.md'),
      v1JourneyDoc('jrn-legacy', '레거시 여정', ['component:src/legacy/**']),
    );
    await Bun.write(
      join(journeysDir, 'checkout.journey.md'),
      v2JourneyDoc('jrn-checkout', '체크아웃 여정', ['component:src/checkout/**']),
    );

    const selection = await selectImpactedJourneys(journeysDir, [
      'src/legacy/old.ts',
      'src/checkout/pay.ts',
    ]);

    // v2 journey selected normally.
    expect(selection.journeys.map((j) => j.id)).toEqual(['jrn-checkout']);

    // v1 journey NOT silently dropped and NOT silently selected — it is invalid.
    expect(selection.journeys.map((j) => j.id)).not.toContain('jrn-legacy');
    expect(selection.invalid_journeys).toHaveLength(1);
    const inv = selection.invalid_journeys[0];
    expect(inv?.file).toBe('e2e/journeys/legacy.journey.md');
    // Clear version-mismatch reason (Contract 7), not a raw zod literal blob.
    expect(inv?.error).toContain('v1 no longer supported');
    expect(inv?.error).toContain('v2');
  });

  test('malformed(비-버전) journey는 고유 파서 오류를 유지한다', async () => {
    await Bun.write(join(journeysDir, 'broken.journey.md'), 'no front matter here\n');
    const selection = await selectImpactedJourneys(journeysDir, ['src/x.ts']);
    expect(selection.invalid_journeys).toHaveLength(1);
    const inv = selection.invalid_journeys[0];
    expect(inv?.file).toBe('e2e/journeys/broken.journey.md');
    // Not a version mismatch → keeps its specific parser message, not the v1 line.
    expect(inv?.error).not.toContain('v1 no longer supported');
  });
});
