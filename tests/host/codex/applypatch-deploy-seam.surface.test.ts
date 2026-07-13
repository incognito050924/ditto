// Codex host surface: apply_patch safety DEPLOYMENT SEAM (OBJ-1, wi_260613ob2).
//
// The sibling fixture (applypatch-safety.surface.test.ts) drives the handler with
// a HARDCODED `--host codex` flag, so it proves the handler logic but BYPASSES the
// deployment seam: whether the shipped `dist/codex-plugin/hooks/hooks.json` command
// actually selects the Codex envelope. OBJ-1 (dialectic-1 + verify) showed it did
// not — the bundled manifest invoked `ditto hook pre-tool-use` with no `--host`, so
// `hook.ts` defaulted host to `claude-code` and the apply_patch gate (gated on
// `input.host === 'codex'`) never fired at real Codex runtime: a secret/scope-out
// apply_patch sailed through (exit 0) — a false-green the fixture could not catch.
//
// This test closes that seam. It NEVER supplies `--host` itself; it drives the
// EXACT command string the built manifest ships, with ${CLAUDE_PLUGIN_ROOT} pointed
// at the build dir (the compiled bin), exactly as a Codex plugin hook would.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';

const REPO = join(import.meta.dir, '..', '..', '..');
const OUT = join(REPO, 'dist', 'codex-plugin');
const HOOKS_JSON = join(OUT, 'hooks', 'hooks.json');

const SESSION = 'codex-deploy-seam';

/** Pull the literal command a given hook event ships in the built manifest. */
function deployedCommand(event: 'PreToolUse' | 'PostToolUse'): string {
  const manifest = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const entry = manifest.hooks[event]?.[0]?.hooks?.[0]?.command;
  if (typeof entry !== 'string') throw new Error(`no ${event} command in ${HOOKS_JSON}`);
  return entry;
}

beforeAll(() => {
  // Build the Codex plugin fresh so the seam test reads the real shipped artifact.
  const proc = Bun.spawnSync(['bun', 'scripts/build-codex-plugin.mjs'], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build:codex-plugin failed: ${proc.stderr.toString()}`);
  }
  if (!existsSync(HOOKS_JSON)) throw new Error(`missing ${HOOKS_JSON} after build`);
});

let projectDir: string;
let wiId: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ditto-codex-deploy-seam-'));
  const wi = await new WorkItemStore(projectDir).create({
    title: 't',
    source_request: 's',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
  await new SessionPointerStore(projectDir).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/**
 * Run the manifest's command verbatim as a Codex plugin hook would: ${CLAUDE_PLUGIN_ROOT}
 * resolves to the build dir (legacy-compat var Codex provides), Codex `cwd` = repo root,
 * no CLAUDE_PROJECT_DIR, kill-switch stripped. NO `--host` is added by the test.
 */
function runDeployed(event: 'PreToolUse' | 'PostToolUse', payload: Record<string, unknown>) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_ROOT: OUT };
  env.CLAUDE_PROJECT_DIR = undefined;
  env.DITTO_SKIP_HOOKS = undefined;
  return Bun.spawnSync(['sh', '-c', deployedCommand(event)], {
    stdin: Buffer.from(JSON.stringify({ cwd: projectDir, session_id: SESSION, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
}

const updateFile = (p: string) =>
  `*** Begin Patch\n*** Update File: ${p}\n@@\n-old\n+new\n*** End Patch`;

describe('Codex apply_patch — deployment seam (OBJ-1)', () => {
  // Artifact assertion: every ditto hook command in the shipped manifest selects
  // the Codex envelope, so the deployment cannot default to claude-code.
  test('shipped hooks.json gives every ditto hook command --host codex', () => {
    const manifest = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const commands: string[] = [];
    for (const event of Object.keys(manifest.hooks)) {
      for (const group of manifest.hooks[event]) {
        for (const h of group.hooks ?? []) {
          if (typeof h.command === 'string' && /\bditto"?\s+hook\s/.test(h.command)) {
            commands.push(h.command);
          }
        }
      }
    }
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd).toContain('--host codex');
    }
  });

  // Behavioral seam: the SHIPPED PreToolUse command (no test-supplied --host) must
  // reach the secret gate and block an apply_patch editing a secret path (exit 2).
  // Before the fix this returned exit 0 (gate unreachable) — the OBJ-1 false-green.
  test('shipped PreToolUse command blocks a secret-path apply_patch (exit 2)', () => {
    const proc = runDeployed('PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { command: updateFile('config/.env') },
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('secret');
  });
});
