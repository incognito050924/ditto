#!/usr/bin/env bun
/**
 * STEP-3 first live self-host demo (wi_2607201id, ac-1 + ac-8) — NOT a unit test.
 *
 * Drives the real rebuild/ outer loop (runDrive) to queue fixpoint with ZERO
 * human intervention, using REAL claude + codex (no mocks). The one demo task:
 * wire the dead `backstop.turns` field into evaluateBackstop so the frozen oracle
 * rebuild/drive/backstop-turns.frozen.test.ts goes green.
 *
 * The autonomous-session knobs are now carried by the SHIPPED seam
 * (`makeLiveHostDeps`), NOT a bespoke wrapper: `--settings <ephemeral>` injects
 * the Stop hook WITHOUT editing the repo-global .claude/settings.json, and
 * `--dangerously-skip-permissions` allows headless file edits. cwd is the repo
 * (where the rebuild/ demo task lives); demo-ws holds the drive state + the
 * injected Stop-hook settings. Still the real claude CLI — not a fake host.
 *
 * COST-BOUNDED: absoluteRoundCeiling 3, per-driveStep timeout, and the loop stops
 * on backstop/oracle/ceiling. Run: bun rebuild/seam/self-host-demo.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { LiveHost, makeLiveHostDeps } from './live-host';
import { liveCodexDeps } from '../verify/codex';
import { parseQueueState, type QueueState } from '../state/queue-state';
import {
  runDrive,
  writeQueueStateAtomic,
  type DriveDeps,
  type DriveConfig,
} from '../drive/outer-loop';
import type { ObservedStructure } from '../verify/structural-anchor';

const REPO = '/Users/incognito/dev/projects/ditto';
const BUN = process.execPath;
const STOP_HOOK = join(REPO, 'rebuild/hook/stop-hook.ts');
const BACKSTOP = join(REPO, 'rebuild/drive/backstop.ts');
const WS = join(REPO, '.ditto/local/work-items/wi_2607201id/evidence/demo-ws');
const STATE_PATH = join(WS, 'state', 'queue.json');
const SETTINGS_PATH = join(WS, 'inject-settings.json');
// Append-only proof that the Stop hook fired INSIDE the drive: the hook's test
// command appends one line per invocation here, and the drive loop never touches
// this file — so any entry is an in-drive fire (not a separate smoke).
const FIRE_LOG = join(WS, 'hook-fires.log');

// Oracle files: frozen (excluded from mutation surface + hash-frozen).
const ORACLE_PATHS = [
  'rebuild/hook/stop-gate.ts',
  'rebuild/verify/codex.ts',
  'rebuild/state/queue-state.ts',
  'rebuild/hook/stop-hook.ts',
  'rebuild/drive/backstop-turns.frozen.test.ts',
];

const DEMO_PROMPT = [
  'You are ONE drive step of an autonomous queue-drain loop for the rebuild/ foundation.',
  'Working directory is the ditto repo. Do EXACTLY this task, nothing more:',
  '',
  '1. The disposition queue has ONE open item:',
  '   q1 (kind unverified-ac): "Wire the dead backstop.turns field into evaluateBackstop."',
  '   The frozen oracle test rebuild/drive/backstop-turns.frozen.test.ts is currently RED.',
  '   READ that test file first to learn the exact required behavior and message format.',
  '   You MUST NOT edit that frozen test (or the completion gate, the codex checker,',
  '   or the queue-state schema) — they are frozen for this run.',
  '',
  '2. Resolve q1 by editing ONLY rebuild/drive/backstop.ts: add an OPTIONAL maxTurns',
  '   field to the opts parameter of evaluateBackstop, and when opts.maxTurns is',
  '   provided and backstop.turns >= opts.maxTurns, push a reason string of the exact',
  '   form "turns <N> >= limit <M>" (e.g. "turns 3 >= limit 3"). Keep every existing',
  '   rule (R1 no_progress, R2 trend) unchanged; omitting maxTurns must keep old behavior.',
  '',
  '3. Run `bun test rebuild/drive/backstop-turns.frozen.test.ts` and confirm it is GREEN.',
  '',
  `4. Update the queue state JSON file at the ABSOLUTE path ${STATE_PATH}: set item q1's`,
  '   "exit" to "resolved", "evidence_ref" to the test result summary, and',
  '   "disposition_note" to what you changed. Leave everything else intact.',
  '',
  '5. Populate your structured boundaryEnvelope output (the SOLE queue oracle):',
  '   queue = [{"id":"q1","kind":"unverified-ac","exit":"resolved"}], and',
  '   gate = {"decision":"pass","grounds":"frozen backstop-turns test green; backstop.turns wired"}.',
  '   Set gate.decision to "pass" ONLY if the frozen test is actually green; otherwise',
  '   leave q1 exit null and gate decision "block". Never over-claim a door you did not earn.',
].join('\n');

function seedState(): void {
  mkdirSync(join(WS, 'state'), { recursive: true });
  const seed: QueueState = {
    round: 0,
    items: [
      {
        id: 'q1',
        kind: 'unverified-ac',
        exit: null,
        evidence_ref: null,
        disposition_note:
          'seed: wire dead backstop.turns into evaluateBackstop; frozen test backstop-turns.frozen.test.ts must go green',
      },
    ],
    acceptance_criteria: [
      { id: 'ac-1', status: 'unverified', evidence_ref: null },
      { id: 'ac-8', status: 'unverified', evidence_ref: null },
    ],
    last_stop_hook: null,
    backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
    blocker: null,
  };
  writeQueueStateAtomic(STATE_PATH, seed);
  // Fresh fire-log so its entries can only come from THIS drive run.
  writeFileSync(FIRE_LOG, '');
}

function writeSettings(): void {
  // The hook's test command: first append one dated line to FIRE_LOG (durable,
  // loop-untouched proof of an in-drive fire), then run the real test — the
  // OVERALL exit code is the test's (last command), so the gate is unaffected.
  const testCmd =
    `printf '%s in-drive-stop-hook-fire\\n' "$(date +%FT%T)" >> '${FIRE_LOG}'; ` +
    `cd '${REPO}' && '${BUN}' test rebuild/drive/backstop-turns.frozen.test.ts rebuild/drive/backstop.test.ts`;
  const hookCmd =
    `VEHICLE_WORKSPACE='${WS}' VEHICLE_TEST_CMD="${testCmd}" '${BUN}' '${STOP_HOOK}'`;
  writeFileSync(
    SETTINGS_PATH,
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCmd }] }] } }, null, 2)}\n`,
  );
}

// The SHIPPED seam carries every real crossing + the autonomous knobs. cwd=REPO
// (the demo task edits rebuild/ code), --settings injects the Stop hook, and
// --dangerously-skip-permissions runs the nested session headless.
const demoHostDeps = makeLiveHostDeps({
  cwd: REPO,
  settingsPath: SETTINGS_PATH,
  skipPermissions: true,
  timeoutMs: 290_000,
});

const driveDeps: DriveDeps = {
  readState: () => parseQueueState(readFileSync(STATE_PATH, 'utf8')),
  // The Stop hook writes last_stop_hook to disk DURING the drive step; the loop's
  // in-memory state (seeded null) would otherwise clobber it on persist. Carry the
  // hook's record forward so the persisted state itself evidences the in-drive fire.
  writeState: (state) => {
    let lastHook = state.last_stop_hook;
    try {
      const onDisk = parseQueueState(readFileSync(STATE_PATH, 'utf8'));
      if (onDisk.last_stop_hook) lastHook = onDisk.last_stop_hook;
    } catch {
      /* first write / unreadable: keep in-memory value */
    }
    writeQueueStateAtomic(STATE_PATH, { ...state, last_stop_hook: lastHook });
  },
  readOracleContent: (path) => {
    const abs = join(REPO, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  },
  // Files this round modified (tracked): the frozen oracle is untracked so it
  // never false-positives here; the hash-freeze in checkOracleIntegrity is the
  // authoritative protection for every oracle regardless of tracking.
  roundDiff: () =>
    execFileSync('git', ['-C', REPO, 'diff', '--name-only'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  codex: liveCodexDeps,
  observedStructures: (): ObservedStructure[] => {
    const src = existsSync(BACKSTOP) ? readFileSync(BACKSTOP, 'utf8') : '';
    return src.includes('maxTurns') ? [{ kind: 'symbol', target: 'maxTurns' }] : [];
  },
};

const config: DriveConfig = {
  absoluteRoundCeiling: 3,
  maxNoProgressRounds: 2,
  timeoutMs: 290_000,
  oraclePaths: ORACLE_PATHS,
  prompt: DEMO_PROMPT,
  structuralExpectations: [
    { criterion_id: 'demo-backstop-turns', kind: 'symbol', target: 'maxTurns' },
  ],
};

async function main(): Promise<void> {
  seedState();
  writeSettings();
  console.log('[demo] workspace:', WS);
  console.log('[demo] oracle paths:', JSON.stringify(ORACLE_PATHS));
  console.log('[demo] ceiling:', config.absoluteRoundCeiling, 'timeoutMs:', config.timeoutMs);

  const host = new LiveHost(demoHostDeps);
  const result = await runDrive(host, driveDeps, config);

  console.log('\n===== DRIVE RESULT =====');
  console.log('outcome:', result.outcome);
  console.log('rounds:', result.rounds);
  console.log('reasons:', JSON.stringify(result.reasons));
  console.log('efficacy:', JSON.stringify(result.efficacy));
  console.log('items:', JSON.stringify(result.state.items, null, 2));
  const allDisposed = result.state.items.every((i) => i.exit !== null);
  console.log('ALL_ITEMS_EXIT_DISPOSED (fixpoint):', allDisposed);
  console.log('FINAL_OUTCOME:', result.outcome);

  // ---- ac-1 evidence: the Stop hook fired INSIDE the drive round ------------
  const fires = existsSync(FIRE_LOG)
    ? readFileSync(FIRE_LOG, 'utf8').split('\n').filter(Boolean)
    : [];
  console.log('\n===== IN-DRIVE STOP-HOOK EVIDENCE =====');
  console.log('HOOK_FIRE_LOG:', FIRE_LOG);
  console.log('HOOK_FIRE_COUNT (in-drive):', fires.length);
  for (const line of fires) console.log('  fire:', line);
  // Re-read the disk state: the hook's last_stop_hook is persisted there (the
  // loop's returned in-memory result.state does not carry the hook's write).
  const diskLastHook = existsSync(STATE_PATH)
    ? parseQueueState(readFileSync(STATE_PATH, 'utf8')).last_stop_hook
    : null;
  console.log(
    'last_stop_hook (persisted on disk from the drive):',
    JSON.stringify(diskLastHook),
  );
  const hookFiredInDrive = fires.length > 0;
  console.log('HOOK_FIRED_INSIDE_DRIVE:', hookFiredInDrive);
  console.log(
    'AC1_INTEGRATED_PROOF:',
    hookFiredInDrive && allDisposed && result.outcome === 'drained'
      ? 'PASS (hook fired in-drive + drained to fixpoint + codex-verified completion)'
      : `PARTIAL (hookInDrive=${hookFiredInDrive} drained=${allDisposed} outcome=${result.outcome})`,
  );
}

main().catch((err) => {
  console.error('[demo] ERROR', err);
  process.exit(1);
});
