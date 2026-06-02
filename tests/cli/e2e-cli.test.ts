import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eJourney } from '~/schemas/e2e-journey';

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

const SPEC = {
  journey: 'login flow',
  url: 'http://localhost:3000/login',
  steps: [{ action: 'click submit', target: 'button[type=submit]' }],
  assertions: [{ description: 'redirected to dashboard' }],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-e2e-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto e2e run CLI', () => {
  test('writes a schema-valid e2eJourney artifact for the given run id (blocked when no browser)', async () => {
    const res = run([
      'e2e',
      'run',
      '--runId',
      'r-cli-01',
      '--output',
      'json',
      '--json',
      JSON.stringify(SPEC),
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.run_id).toBe('r-cli-01');
    // artifact persisted under .ditto/runs/<runId>/journey.json and re-parses through the schema
    const artifact = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'runs', 'r-cli-01', 'journey.json')).text(),
    );
    expect(e2eJourney.safeParse(artifact).success).toBe(true);
    expect(artifact.journey).toBe('login flow');
    expect(['pass', 'fail', 'blocked']).toContain(artifact.result);
  });

  test('rejects a spec missing url (usage error)', async () => {
    const res = run([
      'e2e',
      'run',
      '--runId',
      'r-cli-02',
      '--json',
      JSON.stringify({ journey: 'j', steps: [], assertions: [] }),
    ]);
    expect(res.exitCode).toBe(65); // USAGE_ERROR_EXIT
    expect(res.stderr).toContain('url');
  });

  test('rejects invalid JSON (usage error)', async () => {
    const res = run(['e2e', 'run', '--runId', 'r-cli-03', '--json', '{not json']);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('not valid JSON');
  });
});
