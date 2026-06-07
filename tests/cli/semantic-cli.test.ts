import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OBJ-43 (wi_260605sv1) — `ditto semantic` CLI surface: registration, detect seed,
// multi-pair fail-closed (O1), verdict resolve (O3), and the reproducibility
// fail-closed for an unsubstantiated yes (O5).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_semcli001';

let dir: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

const semanticFile = () =>
  join(dir, '.ditto', 'local', 'work-items', WI, 'semantic-compatibility.json');
const readSemantic = async () => JSON.parse(await readFile(semanticFile(), 'utf8'));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-semcli-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const detectArgs = [
  'semantic',
  'detect',
  '--work-item',
  WI,
  '--file',
  'src/user.ts',
  '--symbol',
  'getUser',
  '--before',
  'getUser(id: string): User | null',
  '--after',
  'getUser(id: string): User',
];

describe('ditto semantic detect', () => {
  test('seeds an unverified artifact (deterministic static layer)', async () => {
    const r = ditto(detectArgs);
    expect(r.exitCode).toBe(0);
    const seed = await readSemantic();
    expect(seed.verdict.semantic_safe).toBe('unverified');
    expect(seed.change).toEqual({
      before: 'getUser(id: string): User | null',
      after: 'getUser(id: string): User',
    });
  });

  test('second detect fail-closes (one signature pair per work item, O1)', async () => {
    expect(ditto(detectArgs).exitCode).toBe(0);
    const r = ditto(detectArgs);
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toContain('already has semantic-compatibility.json');
  });
});

describe('ditto semantic verdict (resolver, O3 deadlock)', () => {
  const seed = () => {
    if (ditto(detectArgs).exitCode !== 0) throw new Error('seed detect failed');
  };

  test('declared intended break resolves the seed', async () => {
    seed();
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'no',
      '--intended-breaking',
      '--old-meaning',
      'null = 사용자 미존재',
    ]);
    expect(r.exitCode).toBe(0);
    const out = await readSemantic();
    expect(out.verdict.semantic_safe).toBe('no');
    expect(out.verdict.intended_breaking).toBe(true);
    expect(out.old_meaning).toBe('null = 사용자 미존재');
  });

  test('yes WITHOUT model-version fail-closes (no unsubstantiated yes, O5)', async () => {
    seed();
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'yes',
      '--old-meaning',
      'null = 미존재',
    ]);
    expect(r.exitCode).toBe(1);
    // seed unchanged — the unverified seed still gates (no silent clear).
    expect((await readSemantic()).verdict.semantic_safe).toBe('unverified');
  });

  test('yes WITH model-version but WITHOUT characterization fail-closes (agent yes needs a witness test, B)', async () => {
    seed();
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'yes',
      '--old-meaning',
      'null = 미존재',
      '--model-version',
      'claude-opus-4-8',
    ]);
    expect(r.exitCode).toBe(1);
    expect((await readSemantic()).verdict.semantic_safe).toBe('unverified');
  });

  test('yes WITH model-version + characterization-test resolves', async () => {
    seed();
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'yes',
      '--old-meaning',
      'null = 미존재',
      '--model-version',
      'claude-opus-4-8',
      '--characterization-test',
      'tests/user.test.ts::keeps null-absence',
    ]);
    expect(r.exitCode).toBe(0);
    const out = await readSemantic();
    expect(out.verdict.semantic_safe).toBe('yes');
    expect(out.verdict.reproducibility.model_version).toBe('claude-opus-4-8');
    expect(out.characterization.test_ref).toBe('tests/user.test.ts::keeps null-absence');
  });

  test('verdict without a prior seed fail-closes', async () => {
    seed();
    await rm(semanticFile(), { force: true });
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'no',
      '--old-meaning',
      'x',
    ]);
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toContain('Run `ditto semantic detect` first');
  });
});
