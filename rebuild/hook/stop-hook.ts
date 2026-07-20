#!/usr/bin/env bun
import { join } from 'node:path';

import { parseQueueState, type QueueState } from '../state/queue-state';
import { evaluateStopGate } from './stop-gate';

/**
 * command-form Stop hook entry point (Artifact C §C). On stop it:
 *   (a) runs the real test runner,
 *   (b) parses state/queue.json (fail-closed) → pending count,
 *   (c) checks each pass-AC carries live evidence,
 *   (d) records the run into state.last_stop_hook,
 * then exits 2 (block stop) if anything is unmet, else 0.
 *
 * Config via env so it is drivable both by Claude Code and by tests:
 *   VEHICLE_WORKSPACE  dir holding state/queue.json      (default: cwd)
 *   VEHICLE_TEST_CMD   shell command for the test runner (default: bun test rebuild/)
 * stdin: the Claude Code Stop-hook JSON ({stop_hook_active, transcript_path}).
 */

export interface HookStdin {
  stop_hook_active?: boolean;
  transcript_path?: string;
}

const COMPLETE_TOKEN = '<FOUNDATION-COMPLETE/>';

function transcriptHasCompleteToken(path: string | undefined): boolean {
  if (!path) return false;
  try {
    const text = require('node:fs').readFileSync(path, 'utf8') as string;
    return text.includes(COMPLETE_TOKEN);
  } catch {
    return false;
  }
}

function runTestRunner(cmd: string, cwd: string): {
  exitCode: number;
  excerpt: string;
} {
  const proc = Bun.spawnSync(['sh', '-c', cmd], { cwd });
  const out =
    new TextDecoder().decode(proc.stdout) +
    new TextDecoder().decode(proc.stderr);
  return { exitCode: proc.exitCode ?? 1, excerpt: out.slice(-500) };
}

export async function runStopHook(
  stdin: HookStdin,
  env: Record<string, string | undefined>,
  nowIso: string,
): Promise<{ exitCode: 0 | 2; stderr: string }> {
  const workspace = env.VEHICLE_WORKSPACE ?? process.cwd();
  const testCmd = env.VEHICLE_TEST_CMD ?? 'bun test rebuild/';
  const statePath = join(workspace, 'state', 'queue.json');
  const fs = require('node:fs');

  const { exitCode: testExitCode, excerpt } = runTestRunner(testCmd, workspace);

  // fail-closed: an unreadable/invalid state document blocks the stop.
  let state: QueueState;
  try {
    state = parseQueueState(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return {
      exitCode: 2,
      stderr: `[stop-gate BLOCK] state/queue.json unreadable or invalid → fail-closed: ${(e as Error).message}`,
    };
  }

  const decision = evaluateStopGate({
    testExitCode,
    state,
    foundationCompleteEmitted: transcriptHasCompleteToken(stdin.transcript_path),
    stopHookActive: stdin.stop_hook_active === true,
  });

  // Record every run into last_stop_hook (the summary the main session cites).
  state.last_stop_hook = {
    command: testCmd,
    exit_code: decision.exitCode,
    timestamp: nowIso,
    output_excerpt: excerpt,
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  if (decision.exitCode === 2) {
    const header = decision.repeatBlock
      ? '[stop-gate BLOCK · repeat]'
      : '[stop-gate BLOCK]';
    const body = decision.reasons.map((r) => `  - ${r}`).join('\n');
    return {
      exitCode: 2,
      stderr: `${header} completion not proven — keep going:\n${body}`,
    };
  }
  return { exitCode: 0, stderr: '' };
}

if (import.meta.main) {
  const raw = await Bun.stdin.text().catch(() => '');
  let stdin: HookStdin = {};
  try {
    stdin = raw.trim() ? (JSON.parse(raw) as HookStdin) : {};
  } catch {
    stdin = {};
  }
  const result = await runStopHook(stdin, process.env, new Date().toISOString());
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exit(result.exitCode);
}
