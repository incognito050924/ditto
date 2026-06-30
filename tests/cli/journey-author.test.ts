import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CLI surface for the two journey-authoring entry points (① story→journey→E2E,
 * ② journey→E2E), a thin citty wrapper over the n3 core
 * (`~/core/journey-authoring`). The state-machine semantics (idempotency,
 * conflict gates, supersede) are covered by core tests; here we verify the CLI
 * actually wires start/record/decompose/finalize to the core and produces the
 * durable per-entity + DSL artifacts on disk (the wiring AC), plus fail-closed
 * payload/arg validation (tech-spec pattern).
 */

const cli = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', cli, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

const WI = 'wi_260630cli';

const JOURNEY_PAYLOAD = JSON.stringify({
  slug: 'checkout',
  name: '결제 여정',
  description: '비회원이 결제를 완료한다',
  owner: 'pm',
  intent: '상품을 담고 그리고 주문한다',
  surfaces: ['page:/checkout'],
  steps: [
    { step_id: 's1', intent: '상품 담기' },
    { step_id: 's2', intent: '주문하기' },
  ],
  implemented: true,
});

const STORY_PAYLOAD = JSON.stringify({
  slug: 'shop',
  owner: 'pm',
  actor: '고객',
  want: '상품을 산다',
  value: '편리하게 구매',
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-journey-author-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('two entry points (ac-1)', () => {
  test('surface ② journey→E2E: start --kind journey succeeds', () => {
    const res = run([
      'journey-author',
      'start',
      '--workItem',
      WI,
      '--kind',
      'journey',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.kind).toBe('journey');
    expect(payload.work_item_id).toBe(WI);
  });

  test('surface ① story→journey→E2E: start --kind story succeeds', () => {
    const res = run([
      'journey-author',
      'start',
      '--workItem',
      WI,
      '--kind',
      'story',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.kind).toBe('story');
  });

  test('invalid --kind is rejected fail-closed (usage exit 65)', () => {
    const res = run(['journey-author', 'start', '--workItem', WI, '--kind', 'epic']);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('kind');
  });
});

describe('finalize wiring → per-entity file + DSL on disk (ac-2/ac-3)', () => {
  test('start → record-journey → finalize produces the journey json + DSL md', () => {
    expect(run(['journey-author', 'start', '--workItem', WI, '--kind', 'journey']).exitCode).toBe(
      0,
    );
    expect(
      run(['journey-author', 'record-journey', '--workItem', WI, '--json', JOURNEY_PAYLOAD])
        .exitCode,
    ).toBe(0);

    const fin = run(['journey-author', 'finalize', '--workItem', WI, '--output', 'json']);
    expect(fin.exitCode).toBe(0);
    const payload = JSON.parse(fin.stdout);
    expect(payload.status).toBe('finalized');
    expect(payload.journeys).toContain('jrn-checkout');
  });

  test('the finalize CLI actually called the core: artifacts exist on disk', async () => {
    run(['journey-author', 'start', '--workItem', WI, '--kind', 'journey']);
    run(['journey-author', 'record-journey', '--workItem', WI, '--json', JOURNEY_PAYLOAD]);
    run(['journey-author', 'finalize', '--workItem', WI]);

    // per-entity journey file (catalog read-side projection source, ADR-0005)
    const perEntity = await readFile(join(dir, '.ditto/local/journeys/jrn-checkout.json'), 'utf8');
    expect(JSON.parse(perEntity).id).toBe('jrn-checkout');
    // journey DSL file
    const dsl = await readFile(join(dir, 'e2e/journeys/checkout.journey.md'), 'utf8');
    expect(dsl).toContain('id: jrn-checkout');
    expect(dsl).toContain('[s1]');
  });

  test('story surface finalize emits the per-entity story file too', async () => {
    run(['journey-author', 'start', '--workItem', WI, '--kind', 'story']);
    run(['journey-author', 'record-story', '--workItem', WI, '--json', STORY_PAYLOAD]);
    run(['journey-author', 'record-journey', '--workItem', WI, '--json', JOURNEY_PAYLOAD]);
    const fin = run(['journey-author', 'finalize', '--workItem', WI, '--output', 'json']);
    expect(fin.exitCode).toBe(0);
    const story = await readFile(join(dir, '.ditto/local/stories/us-shop.json'), 'utf8');
    expect(JSON.parse(story).journey_ids).toContain('jrn-checkout');
  });

  test('finalize without start → runtime error (not_started)', () => {
    const res = run(['journey-author', 'finalize', '--workItem', WI]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain('never started');
  });
});

describe('auto-decompose presents a draft, never auto-confirms (ac-5)', () => {
  test('decompose proposes ordered steps and marks the output as a proposal', () => {
    const res = run([
      'journey-author',
      'decompose',
      '--intent',
      '상품을 담고 그리고 쿠폰을 적용하고 그리고 주문한다',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.proposed).toBe(true);
    expect(payload.steps.length).toBe(3);
    expect(payload.steps[0].step_id).toBe('s1');
    // it must NOT have written a session / journey (proposal only)
    expect(payload.note).toBeTruthy();
  });

  test('decompose writes no journey artifact (proposal is not a commitment)', async () => {
    run(['journey-author', 'decompose', '--intent', '주문을 완료한다']);
    await expect(
      readFile(join(dir, '.ditto/local/journeys/jrn-checkout.json'), 'utf8'),
    ).rejects.toBeTruthy();
  });
});

describe('payload validation fail-closed', () => {
  test('record-journey with malformed JSON → usage exit 65', () => {
    run(['journey-author', 'start', '--workItem', WI, '--kind', 'journey']);
    const res = run(['journey-author', 'record-journey', '--workItem', WI, '--json', '{not json']);
    expect(res.exitCode).toBe(65);
  });

  test('record-journey with schema-invalid payload (missing surfaces) → usage exit 65', () => {
    run(['journey-author', 'start', '--workItem', WI, '--kind', 'journey']);
    const bad = JSON.stringify({ slug: 'x', name: 'n', description: 'd', owner: 'o', intent: 'i' });
    const res = run(['journey-author', 'record-journey', '--workItem', WI, '--json', bad]);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('schema');
  });
});
