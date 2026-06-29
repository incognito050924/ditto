import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `ditto workspace sync` end-to-end through the real CLI binary entry (the path
// N6's e2e smoke reuses). The DITTO_ALLOW_LOCAL_CLONE=1 env seam lets the test
// drive the REAL clone path against a LOCAL source repo (the url allowlist rejects
// local transports without it — proving the seam gates the live binary).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');

let ws: string;
let src: string;

function ditto(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: ws,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function writeRecipe(repos: { dir: string; url: string }[]): Promise<void> {
  const body = ['repos:', ...repos.flatMap((r) => [`  - dir: ${r.dir}`, `    url: ${r.url}`])].join(
    '\n',
  );
  await writeFile(join(ws, 'recipe.yaml'), `${body}\n`);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ditto-ws-cli-'));
  await mkdir(join(ws, '.ditto'), { recursive: true }); // anchor resolveRepoRootForCreate
  src = await mkdtemp(join(tmpdir(), 'ditto-ws-cli-src-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: src });
  await writeFile(join(src, 'README.md'), '# src\n');
  execFileSync('git', ['add', '.'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
    cwd: src,
  });
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
});

describe('ditto workspace sync (CLI)', () => {
  test('clones declared repos under the local-transport seam → exit 0', async () => {
    await writeRecipe([{ dir: 'sub', url: src }]);
    const r = ditto(['workspace', 'sync', '--output', 'json'], { DITTO_ALLOW_LOCAL_CLONE: '1' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.outcomes[0].status).toBe('cloned');
    expect(existsSync(join(ws, 'sub', 'README.md'))).toBe(true);
  });

  test('multi-repo partial fail continues and exits NON-ZERO', async () => {
    await writeRecipe([
      { dir: 'ok', url: src },
      { dir: 'bad', url: join(tmpdir(), 'ditto-cli-no-such-repo.git') },
    ]);
    const r = ditto(['workspace', 'sync', '--output', 'json'], { DITTO_ALLOW_LOCAL_CLONE: '1' });
    expect(r.exitCode).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    const byDir = Object.fromEntries(
      parsed.outcomes.map((o: { dir: string; status: string }) => [o.dir, o.status]),
    );
    expect(byDir.ok).toBe('cloned');
    expect(byDir.bad).toBe('failed');
  });

  test('without the env seam the local url is refused by the allowlist (no clone)', async () => {
    await writeRecipe([{ dir: 'sub', url: src }]);
    const r = ditto(['workspace', 'sync', '--output', 'json']); // no DITTO_ALLOW_LOCAL_CLONE
    const parsed = JSON.parse(r.stdout);
    expect(parsed.outcomes[0].status).toBe('refused');
    expect(existsSync(join(ws, 'sub'))).toBe(false);
  });
});
