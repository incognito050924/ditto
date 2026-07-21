#!/usr/bin/env bun
/**
 * STEP-1 live de-risk smoke (#wi_2607201id, ac-1 precondition) — NOT a unit test.
 *
 * Proves the DESIGN decision empirically: spawn `claude --print` with cwd = an
 * ephemeral workspace dir that carries its OWN project `.claude/settings.json`
 * Stop hook (`bun <abs>/rebuild/hook/stop-hook.ts`), so the repo's global
 * `.claude/settings.json` is NEVER edited. If the Stop hook fires, it writes
 * `last_stop_hook` into the seeded state/queue.json — that write is the proof.
 *
 * Cost: exactly ONE real `claude --print` call. The seeded state is already
 * drained + the test command is trivial (exit 0), so the gate returns exit 0
 * (allow stop) — no exit-2 continue-loop, single turn.
 *
 * Run: bun rebuild/seam/hook-fire-smoke.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = '/Users/incognito/dev/projects/ditto';
const STOP_HOOK = join(REPO, 'rebuild/hook/stop-hook.ts');
const BUN = process.execPath; // absolute bun

function main(): void {
  const ws = mkdtempSync(join(tmpdir(), 'ditto-hookfire-'));
  const token = `SMOKE_FIRE_${Math.random().toString(36).slice(2, 10)}`;
  mkdirSync(join(ws, 'state'), { recursive: true });
  mkdirSync(join(ws, '.claude'), { recursive: true });

  // Seeded state: already DRAINED (item has an exit), no AC over-claims, so the
  // gate returns exit 0 (allow stop) — single claude turn, no continue-loop.
  const seed = {
    round: 0,
    items: [
      { id: 'q1', kind: 'unverified-ac', exit: 'resolved', evidence_ref: 'smoke', disposition_note: 'seed' },
    ],
    acceptance_criteria: [] as unknown[],
    last_stop_hook: null,
    backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] as number[] },
    blocker: null,
  };
  const statePath = join(ws, 'state', 'queue.json');
  writeFileSync(statePath, `${JSON.stringify(seed, null, 2)}\n`);

  // Project-scoped Stop hook. Env is embedded directly in the command so it does
  // not depend on env inheritance: VEHICLE_TEST_CMD echoes a unique token then
  // exits 0 (so the gate opens); VEHICLE_WORKSPACE points at this workspace.
  const testCmd = `echo ${token}; true`;
  const hookCmd =
    `VEHICLE_WORKSPACE='${ws}' VEHICLE_TEST_CMD='${testCmd}' ` +
    `'${BUN}' '${STOP_HOOK}'`;
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hookCmd }] }],
    },
  };
  writeFileSync(join(ws, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

  console.log('[smoke] workspace:', ws);
  console.log('[smoke] token:', token);
  console.log('[smoke] hook command:', hookCmd);

  // ONE real claude --print, cwd = workspace. Trivial prompt so it stops fast.
  let cliOut = '';
  let cliErr = '';
  let cliExit = 0;
  try {
    cliOut = execFileSync(
      'claude',
      ['--print', '--output-format', 'text', 'Reply with exactly one word: ready'],
      { cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
    );
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    cliOut = err.stdout?.toString() ?? '';
    cliErr = err.stderr?.toString() ?? '';
    cliExit = err.status ?? 1;
  }
  console.log('[smoke] claude exit:', cliExit);
  console.log('[smoke] claude stdout:', JSON.stringify(cliOut.slice(0, 300)));
  if (cliErr) console.log('[smoke] claude stderr:', JSON.stringify(cliErr.slice(0, 500)));

  // The proof: did the hook write last_stop_hook back into queue.json?
  const after = JSON.parse(readFileSync(statePath, 'utf8')) as Omit<typeof seed, 'last_stop_hook'> & {
    last_stop_hook: { command: string; exit_code: number; output_excerpt: string } | null;
  };
  const lsh = after.last_stop_hook;
  const fired = lsh !== null;
  const markerSeen = fired && lsh.output_excerpt.includes(token);
  console.log('[smoke] last_stop_hook after run:', JSON.stringify(lsh));
  console.log(`[smoke] HOOK_FIRED=${fired} MARKER_SEEN=${markerSeen}`);

  const pass = fired && markerSeen;
  console.log(`SMOKE ${pass ? 'PASS' : 'FAIL'} (workspace kept: ${ws})`);
  if (!pass) process.exit(1);
}

main();
