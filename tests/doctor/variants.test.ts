import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;
let home: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: home },
  });
}

async function writeVariant(name: string, role = 'implementer') {
  await mkdir(join(dir, '.ditto', 'agents'), { recursive: true });
  await writeFile(
    join(dir, '.ditto', 'agents', `${name}.md`),
    `---\nname: ${name}\nrole: ${role}\ndescription: |\n  test variant\n---\n`,
    'utf8',
  );
}

async function registerHostAgent(name: string) {
  await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, '.claude', 'agents', `${name}.md`), `# ${name}\n`, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-variants-'));
  home = await mkdtemp(join(tmpdir(), 'ditto-home-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('doctor variants', () => {
  test('orphan variant (no host registration) is reported as drift with non-zero exit', async () => {
    await writeVariant('ghost-implementer');
    // no matching .claude/agents/ghost-implementer.md
    const proc = run(['doctor', 'variants', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('drift');
    expect(json.orphans).toContain('ghost-implementer');
  });

  test('orphan 0 (all registered) is ok with exit 0', async () => {
    await writeVariant('cli-implementer');
    await registerHostAgent('cli-implementer');
    const proc = run(['doctor', 'variants', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('ok');
    expect(json.orphan_count).toBe(0);
  });

  test('--advisory keeps exit 0 even with orphan drift', async () => {
    await writeVariant('ghost-implementer');
    const proc = run(['doctor', 'variants', '--advisory', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('drift');
    expect(json.orphan_count).toBeGreaterThan(0);
  });

  // ac-2: --fix registers orphan variants into .claude/agents idempotently.
  test('--fix copies an orphan to .claude/agents and a re-run reports orphan 0', async () => {
    await writeVariant('ghost-implementer');

    const fix = run(['doctor', 'variants', '--fix']);
    expect(fix.exitCode).toBe(0); // --fix never raises a drift exit

    // The host registration file now exists with the variant body copied over.
    const dest = join(dir, '.claude', 'agents', 'ghost-implementer.md');
    const copied = await readFile(dest, 'utf8');
    expect(copied).toContain('name: ghost-implementer');

    // Re-run detection: drift cleared, orphan 0.
    const after = run(['doctor', 'variants', '--output', 'json']);
    expect(after.exitCode).toBe(0);
    const json = JSON.parse(after.stdout.toString());
    expect(json.status).toBe('ok');
    expect(json.orphan_count).toBe(0);
  });

  test('--fix run twice is a no-op (idempotent)', async () => {
    await writeVariant('ghost-implementer');
    const first = run(['doctor', 'variants', '--fix']);
    expect(first.exitCode).toBe(0);
    const dest = join(dir, '.claude', 'agents', 'ghost-implementer.md');
    const afterFirst = await readFile(dest, 'utf8');

    const second = run(['doctor', 'variants', '--fix']);
    expect(second.exitCode).toBe(0);
    const afterSecond = await readFile(dest, 'utf8');
    expect(afterSecond).toBe(afterFirst); // unchanged
  });

  test('--fix does not clobber an existing host file (preserves hand-edits)', async () => {
    await writeVariant('cli-implementer');
    // Host file already present with hand-edited content.
    await registerHostAgent('cli-implementer');
    const dest = join(dir, '.claude', 'agents', 'cli-implementer.md');
    const before = await readFile(dest, 'utf8');
    expect(before).toBe('# cli-implementer\n');

    const fix = run(['doctor', 'variants', '--fix']);
    expect(fix.exitCode).toBe(0);

    const after = await readFile(dest, 'utf8');
    expect(after).toBe(before); // hand-edit preserved, not overwritten
  });
});
