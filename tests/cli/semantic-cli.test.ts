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

const detectArgs2 = [
  'semantic',
  'detect',
  '--work-item',
  WI,
  '--file',
  'src/user.ts',
  '--symbol',
  'listUsers',
  '--before',
  'listUsers(): User[] | null',
  '--after',
  'listUsers(): User[]',
];

describe('ditto semantic detect', () => {
  test('seeds an unverified artifact (deterministic static layer)', async () => {
    const r = ditto(detectArgs);
    expect(r.exitCode).toBe(0);
    const seed = await readSemantic();
    expect(seed.changes).toHaveLength(1);
    expect(seed.changes[0].verdict.semantic_safe).toBe('unverified');
    expect({ before: seed.changes[0].before, after: seed.changes[0].after }).toEqual({
      before: 'getUser(id: string): User | null',
      after: 'getUser(id: string): User',
    });
  });

  // G4 (wi_260614gd9): a second detect APPENDS a new pair (multi-change), so every
  // detected change reaches the gate instead of the first clobbering the rest.
  test('second detect appends a new pair (multi-change)', async () => {
    expect(ditto(detectArgs).exitCode).toBe(0);
    const r = ditto(detectArgs2);
    expect(r.exitCode).toBe(0);
    const seed = await readSemantic();
    expect(seed.changes).toHaveLength(2);
    expect(seed.changes.map((c: { before: string }) => c.before)).toEqual([
      'getUser(id: string): User | null',
      'listUsers(): User[] | null',
    ]);
  });

  test('re-detecting the SAME pair fail-closes (would clobber a verdict)', async () => {
    expect(ditto(detectArgs).exitCode).toBe(0);
    const r = ditto(detectArgs);
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toContain('already has');
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
    expect(out.changes[0].verdict.semantic_safe).toBe('no');
    expect(out.changes[0].verdict.intended_breaking).toBe(true);
    expect(out.changes[0].old_meaning).toBe('null = 사용자 미존재');
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
    expect((await readSemantic()).changes[0].verdict.semantic_safe).toBe('unverified');
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
    expect((await readSemantic()).changes[0].verdict.semantic_safe).toBe('unverified');
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
    expect(out.changes[0].verdict.semantic_safe).toBe('yes');
    expect(out.changes[0].verdict.reproducibility.model_version).toBe('claude-opus-4-8');
    expect(out.changes[0].characterization.test_ref).toBe('tests/user.test.ts::keeps null-absence');
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

  // G4 (wi_260614gd9): with multiple pairs, --before/--after select which to
  // resolve; resolving one leaves the other unverified.
  test('multi-pair: targeted verdict resolves one pair, the other stays unverified', async () => {
    expect(ditto(detectArgs).exitCode).toBe(0);
    expect(ditto(detectArgs2).exitCode).toBe(0);
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'no',
      '--intended-breaking',
      '--old-meaning',
      'null = 미존재',
      '--before',
      'getUser(id: string): User | null',
      '--after',
      'getUser(id: string): User',
    ]);
    expect(r.exitCode).toBe(0);
    const out = await readSemantic();
    const getUserPair = out.changes.find(
      (c: { before: string }) => c.before === 'getUser(id: string): User | null',
    );
    const listPair = out.changes.find(
      (c: { before: string }) => c.before === 'listUsers(): User[] | null',
    );
    expect(getUserPair.verdict.semantic_safe).toBe('no');
    expect(getUserPair.verdict.intended_breaking).toBe(true);
    expect(listPair.verdict.semantic_safe).toBe('unverified');
  });

  test('multi-pair: verdict WITHOUT --before/--after fail-closes (cannot guess the pair)', async () => {
    expect(ditto(detectArgs).exitCode).toBe(0);
    expect(ditto(detectArgs2).exitCode).toBe(0);
    const r = ditto([
      'semantic',
      'verdict',
      '--work-item',
      WI,
      '--semantic-safe',
      'no',
      '--intended-breaking',
      '--old-meaning',
      'x',
    ]);
    expect(r.exitCode).toBe(1);
    // Both pairs untouched.
    const out = await readSemantic();
    expect(
      out.changes.every(
        (c: { verdict: { semantic_safe: string } }) => c.verdict.semantic_safe === 'unverified',
      ),
    ).toBe(true);
  });
});
