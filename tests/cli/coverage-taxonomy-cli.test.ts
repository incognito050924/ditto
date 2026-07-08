import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto coverage list|add|disable|reroute|discover` — the tier-② far-field
 * taxonomy management surface (wi_260707phi ac-1/ac-2/ac-4/ac-5/ac-6/ac-7). These
 * commands are a thin CLI over the already-committed cores
 * (applyTaxonomyMutation / loadFarFieldTaxonomy / admitDiscoveredCategories); the
 * recurring failure mode is dead-wiring, so every test asserts the REAL core ran:
 * the `.ditto/coverage-taxonomy.json` file is actually written on a mutation and
 * NOT written on a propose, and the discovery gate really drops re-confirming /
 * ungrounded candidates.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(
  args: string[],
  stdin?: string,
): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    env: { ...process.env },
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

/** The tier-② config the mutations write (git-tracked, NOT under local/). */
function configPath(): string {
  return join(dir, '.ditto', 'coverage-taxonomy.json');
}

async function readConfig(): Promise<Record<string, unknown> | null> {
  const f = Bun.file(configPath());
  if (!(await f.exists())) return null;
  return JSON.parse(await f.text());
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-covtax-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto coverage list (ac-1)', () => {
  test('no override → every entry is floor, no disabled, 23 floor categories', async () => {
    const res = spawnDitto(['coverage', 'list', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.entries.length).toBe(23);
    expect(payload.disabled).toEqual([]);
    for (const e of payload.entries) expect(e.status).toBe('floor');
    const auth = payload.entries.find((e: { id: string }) => e.id === 'authentication');
    expect(auth).toBeDefined();
    expect(auth.disposition).toBe('code-verify');
    expect(typeof auth.lens).toBe('string');
  });

  test('after add → the added category shows status=added', async () => {
    const add = spawnDitto([
      'coverage',
      'add',
      '--id',
      'ai-prompt-injection',
      '--lens',
      '신뢰할 수 없는 텍스트가 LLM 프롬프트로 흘러드나?',
      '--output',
      'json',
    ]);
    expect(add.exitCode).toBe(0);
    const res = spawnDitto(['coverage', 'list', '--output', 'json']);
    const payload = JSON.parse(res.stdout);
    const added = payload.entries.find((e: { id: string }) => e.id === 'ai-prompt-injection');
    expect(added).toBeDefined();
    expect(added.status).toBe('added');
  });

  test('after disable → the floor id is in disabled and gone from active entries', async () => {
    spawnDitto([
      'coverage',
      'disable',
      '--id',
      'time-clock',
      '--reason',
      'this project has no time-dependent logic',
      '--output',
      'json',
    ]);
    const res = spawnDitto(['coverage', 'list', '--output', 'json']);
    const payload = JSON.parse(res.stdout);
    expect(payload.entries.find((e: { id: string }) => e.id === 'time-clock')).toBeUndefined();
    expect(payload.entries.length).toBe(22);
    expect(payload.disabled.some((d: { id: string }) => d.id === 'time-clock')).toBe(true);
  });

  test('after reroute → the floor id shows status=rerouted with the new disposition', async () => {
    spawnDitto([
      'coverage',
      'reroute',
      '--id',
      'auditing',
      '--disposition',
      'user-intent',
      '--output',
      'json',
    ]);
    const res = spawnDitto(['coverage', 'list', '--output', 'json']);
    const payload = JSON.parse(res.stdout);
    const auditing = payload.entries.find((e: { id: string }) => e.id === 'auditing');
    expect(auditing.status).toBe('rerouted');
    expect(auditing.disposition).toBe('user-intent');
  });

  test('malformed config → warns on stderr and falls back to the floor (fail-open)', async () => {
    await writeFile(configPath(), '{ this is not valid json', 'utf8');
    const res = spawnDitto(['coverage', 'list', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('malformed');
    const payload = JSON.parse(res.stdout);
    expect(payload.entries.length).toBe(23);
  });
});

describe('ditto coverage add (ac-2)', () => {
  test('add writes the config file and the core stored the entry (wired)', async () => {
    expect(await readConfig()).toBeNull();
    const res = spawnDitto([
      'coverage',
      'add',
      '--id',
      'supply-chain-provenance',
      '--lens',
      '의존성 출처·서명·핀 고정이 검증되나?',
      '--disposition',
      'code-verify',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const cfg = await readConfig();
    expect(cfg).not.toBeNull();
    const added = (cfg?.added as { id: string; lens: string; disposition?: string }[]) ?? [];
    const entry = added.find((a) => a.id === 'supply-chain-provenance');
    expect(entry).toBeDefined();
    expect(entry?.lens).toContain('의존성');
    expect(entry?.disposition).toBe('code-verify');
  });

  test('add a duplicate floor id → error, config NOT written', async () => {
    const res = spawnDitto([
      'coverage',
      'add',
      '--id',
      'authentication',
      '--lens',
      'dup of a floor id',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });

  test('add with an invalid --disposition → usage error (65), config NOT written', async () => {
    const res = spawnDitto([
      'coverage',
      'add',
      '--id',
      'new-cat',
      '--lens',
      'x',
      '--disposition',
      'not-a-route',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });

  test('add missing --lens → usage error (65)', async () => {
    const res = spawnDitto(['coverage', 'add', '--id', 'new-cat', '--output', 'json']);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });
});

describe('ditto coverage disable (ac-2)', () => {
  test('disable a floor id with --reason → config has disabled + disabled_reasons', async () => {
    const res = spawnDitto([
      'coverage',
      'disable',
      '--id',
      'time-clock',
      '--reason',
      'no time-dependent logic in this product',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const cfg = await readConfig();
    expect((cfg?.disabled as string[]) ?? []).toContain('time-clock');
    expect((cfg?.disabled_reasons as Record<string, string>)?.['time-clock']).toContain(
      'no time-dependent',
    );
  });

  test('disable WITHOUT --reason → usage error (65), config NOT written', async () => {
    const res = spawnDitto(['coverage', 'disable', '--id', 'time-clock', '--output', 'json']);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });

  test('disable an id NOT in floor∪added → error (no silent no-op), config NOT written', async () => {
    const res = spawnDitto([
      'coverage',
      'disable',
      '--id',
      'no-such-category',
      '--reason',
      'typo',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });
});

describe('ditto coverage reroute (ac-2)', () => {
  test('reroute a floor id → config dispositions map updated', async () => {
    const res = spawnDitto([
      'coverage',
      'reroute',
      '--id',
      'auditing',
      '--disposition',
      'user-intent',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const cfg = await readConfig();
    expect((cfg?.dispositions as Record<string, string>)?.auditing).toBe('user-intent');
  });

  test('reroute an unknown id → error (no silent no-op), config NOT written', async () => {
    const res = spawnDitto([
      'coverage',
      'reroute',
      '--id',
      'no-such-category',
      '--disposition',
      'user-intent',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });

  test('reroute without --disposition → usage error (65)', async () => {
    const res = spawnDitto(['coverage', 'reroute', '--id', 'auditing', '--output', 'json']);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });
});

describe('ditto coverage discover (ac-5/ac-6/ac-7)', () => {
  async function writeCandidates(candidates: unknown): Promise<string> {
    const p = join(dir, 'candidates.json');
    await writeFile(p, JSON.stringify(candidates), 'utf8');
    return p;
  }

  const gap = {
    id: 'supply-chain-provenance',
    lens: '의존성 출처가 검증되나?',
    evidence: 'package.json:express is pulled unpinned',
  };
  const reconfirm = {
    id: 'authentication',
    lens: 're-states a floor category',
    evidence: 'src/auth.ts:12',
  };
  const ungrounded = {
    id: 'vibes-only',
    lens: 'a hunch with no citation',
    evidence: 'I just feel this could be a problem',
  };

  test('admits a grounded gap; drops reconfirms_covered and no_evidence; propose does NOT mutate (ac-5/ac-6/ac-7)', async () => {
    const file = await writeCandidates([gap, reconfirm, ungrounded]);
    const res = spawnDitto(['coverage', 'discover', '--file', file, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);

    const admittedIds = payload.admitted.map((a: { id: string }) => a.id);
    expect(admittedIds).toEqual(['supply-chain-provenance']);
    expect(payload.admitted[0].lens).toContain('의존성');

    const dropById: Record<string, string> = {};
    for (const d of payload.dropped) dropById[d.id] = d.reason;
    expect(dropById.authentication).toBe('reconfirms_covered');
    expect(dropById['vibes-only']).toBe('no_evidence');

    // ac-7: proposing (no --confirm) mutates NOTHING.
    expect(payload.confirmed).toBe(false);
    expect(await readConfig()).toBeNull();
  });

  test('--confirm routes ONLY the admitted gap through applyTaxonomyMutation (ac-7)', async () => {
    const file = await writeCandidates([gap, reconfirm, ungrounded]);
    const res = spawnDitto([
      'coverage',
      'discover',
      '--file',
      file,
      '--confirm',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.confirmed).toBe(true);
    expect(payload.added).toEqual(['supply-chain-provenance']);

    const cfg = await readConfig();
    const added = (cfg?.added as { id: string }[]) ?? [];
    expect(added.map((a) => a.id)).toEqual(['supply-chain-provenance']);
  });

  test('candidates via stdin also flow through the gate', async () => {
    const res = spawnDitto(['coverage', 'discover', '--output', 'json'], JSON.stringify([gap]));
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.admitted.map((a: { id: string }) => a.id)).toEqual(['supply-chain-provenance']);
  });

  test('malformed candidate JSON → usage error (65), no mutation', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, 'not json at all', 'utf8');
    const res = spawnDitto([
      'coverage',
      'discover',
      '--file',
      file,
      '--confirm',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(65);
    expect(await readConfig()).toBeNull();
  });
});
