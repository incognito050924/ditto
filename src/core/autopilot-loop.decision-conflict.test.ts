import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { workCommand } from '../cli/commands/work';
import {
  DECISION_CONFLICT_CLEARED_MARKER,
  applyDecisionConflictDeclaration,
  intentConflictPassCloseBlocker,
  planRequiresDecisionApproval,
} from './autopilot-loop';
import { AutopilotStore } from './autopilot-store';
import { PLACEHOLDER_AC_STATEMENT } from './charter';
import { WorkItemStore } from './work-item-store';

/**
 * WHY THESE TESTS EXIST (wi_2607222uc, node n-impl-carrier-lifecycle — ADR-0020
 * decision-conflict carrier PRODUCER lifecycle + done-gate seam).
 *
 * ac-2 (carrier lifecycle on a contentful design pass):
 *  - an EXPLICIT `decision_conflicts: []` means the planner JUDGED there are no
 *    conflicts — the engine may then clear only the agent-resolvable entries
 *    (method-level, and any `prefer`) from a pre-existing carrier; INTENT-level
 *    entries are user-owned (사용자 전유 해소 원칙) and must SURVIVE the clear —
 *    they leave only via a verified supersede resolution or a terminal close;
 *  - when nothing remains, the carrier FILE itself is removed (and a second []
 *    pass tolerates the missing file — idempotent for node re-dispatch);
 *  - every clear/removal appends ONE decision-log record (무흔적 소멸 금지) naming
 *    the node, the removed adr_ids and the preserved intent entries — a normal
 *    non-blocking record, never an escalation;
 *  - `decision_conflicts: undefined` means NO judgment — the carrier is left
 *    byte-identical (the branch that pins the []-vs-undefined split);
 *  - a non-empty re-declaration MERGES by adr_id: an existing entry's
 *    `resolution` record survives the rewrite (no clobber). The `resolution`
 *    field is landed by a sibling node in src/schemas/**; these tests construct
 *    it as plain JSON data through the writer's own raw read/write path.
 *
 * ac-3 (done-gate seam): `ditto work done`'s PASS-close refuses while the
 * carrier holds an unresolved intent-level (forbid|require × intent) conflict;
 * a malformed carrier also refuses (fail-closed). Absent / method-prefer-only /
 * VERIFIED-resolved ⇒ no effect. Parking (--status partial|blocked) and abandon
 * are the sanctioned exits and stay untouched (not exercised here — the gate is
 * wired into the DONE(pass) path only).
 *
 * Resolution VERIFICATION (review fix n-review-dc.fix.r0, F1/F2): a `resolution`
 * record on a carrier entry is a CLAIM, not evidence — both the done pass-close
 * blocker (`intentConflictPassCloseBlocker`) and the plan front-load
 * (`planRequiresDecisionApproval`) must verify it via `splitResolvedConflicts`
 * against the ADR status line AT THE HEAD COMMIT (`readAdrStatusAtHead`). Only a
 * COMMITTED superseded ADR demotes the block; an unverifiable claim (no git
 * repo, still-accepted ADR, absent file) stays BLOCKING (fail-closed). These
 * tests pin: verified-resolved ⇒ no block / no approval front-load; unverified
 * claim ⇒ refusal / approval still front-loaded. Git fixtures follow the
 * committed-ADR pattern of src/core/adr-status.test.ts.
 *
 * All fixtures are throwaway mkdtemp roots (absolute paths) — the deletion
 * branches never resolve against the real repo.
 */

const fixtures: string[] = [];
const origCwd = process.cwd();

afterEach(async () => {
  process.chdir(origCwd);
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const WI = 'wi_dcfixture1';
const NODE_ID = 'n-design';

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-dc-'));
  fixtures.push(dir);
  return dir;
}

function git(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr?.toString()}`);
  }
}

/** Turn a fixture root into a git repo with an identity and one initial commit. */
async function makeGitRoot(): Promise<string> {
  const dir = await makeRoot();
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);
  await writeFile(join(dir, 'README.md'), 'fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

/** Commit an ADR body at HEAD so `readAdrStatusAtHead` sees landed positive evidence. */
async function commitAdrFile(root: string, filename: string, body: string): Promise<void> {
  const rel = join('.ditto', 'knowledge', 'adr', filename);
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  git(root, ['add', rel]);
  git(root, ['commit', '-m', `adr ${filename}`]);
}

const SUCCESSOR_ID = 'ADR-20260722-successor';

/** Committed body whose status LINE marks ADR-0011 superseded by the claimed successor. */
const SUPERSEDED_ADR_0011_BODY = [
  '# ADR-0011: fixture',
  '',
  `- 상태: superseded by ${SUCCESSOR_ID}`,
  '',
  '본문.',
  '',
].join('\n');

/** Committed body whose status LINE is still accepted — a resolution claim against it must fail. */
const ACCEPTED_ADR_0011_BODY = [
  '# ADR-0011: fixture',
  '',
  '- 상태: accepted',
  '',
  '본문.',
  '',
].join('\n');

const verifiedResolution = {
  superseded_by: SUCCESSOR_ID,
  basis: 'user-gated supersede landed; re-judged against the successor',
} as const;

function wiDir(root: string, wi: string = WI): string {
  return join(root, '.ditto', 'local', 'work-items', wi);
}

function carrierPath(root: string, wi: string = WI): string {
  return join(wiDir(root, wi), 'decision-conflict.json');
}

async function seedCarrier(root: string, conflicts: unknown[], wi: string = WI): Promise<void> {
  await mkdir(wiDir(root, wi), { recursive: true });
  await writeFile(
    carrierPath(root, wi),
    `${JSON.stringify({ schema_version: '0.1.0', mode: 'autopilot', conflicts }, null, 2)}\n`,
    'utf8',
  );
}

async function readCarrierRaw(root: string): Promise<{
  schema_version: string;
  mode: string;
  conflicts: Record<string, unknown>[];
}> {
  return JSON.parse(await readFile(carrierPath(root), 'utf8'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readDecisionLog(root: string): Promise<Record<string, unknown>[]> {
  const path = join(wiDir(root), 'autopilot-decisions.jsonl');
  if (!(await fileExists(path))) return [];
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const intentForbid = {
  adr_id: 'ADR-0011',
  kind: 'forbid',
  level: 'intent',
  basis: 'the goal itself wants cross-repo subagent delegation, which the ADR forbids',
} as const;

const methodRequire = {
  adr_id: 'ADR-0017',
  kind: 'require',
  level: 'method',
  basis: 'the candidate tidy path must ride the ACG gate — re-routable by following the ADR',
} as const;

const preferIntent = {
  adr_id: 'ADR-0020',
  kind: 'prefer',
  level: 'intent',
  basis: 'weak preference conflict — justification-only, agent-resolvable',
} as const;

function apply(
  root: string,
  declared:
    | (typeof intentForbid | typeof methodRequire | typeof preferIntent | object)[]
    | undefined,
): Promise<void> {
  return applyDecisionConflictDeclaration({
    repoRoot: root,
    workItemId: WI,
    nodeId: NODE_ID,
    // biome-ignore lint/suspicious/noExplicitAny: tests drive the raw-JSON seam deliberately
    declared: declared as any,
    appendDecision: (d) => new AutopilotStore(root).appendDecision(WI, d),
    now: new Date('2026-07-23T00:00:00.000Z'),
  });
}

describe('applyDecisionConflictDeclaration — explicit [] (judged-none) clear', () => {
  test('[] with mixed entries keeps intent, drops method/prefer, appends one clear record', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [intentForbid, methodRequire, preferIntent]);
    await apply(root, []);
    const carrier = await readCarrierRaw(root);
    expect(carrier.conflicts.map((c) => c.adr_id)).toEqual(['ADR-0011']);
    expect(carrier.conflicts[0]?.level).toBe('intent');
    expect(carrier.schema_version).toBe('0.1.0');
    expect(carrier.mode).toBe('autopilot');
    const log = await readDecisionLog(root);
    expect(log).toHaveLength(1);
    const entry = log[0] as { node_id: string; reason: string; decision: string };
    expect(entry.node_id).toBe(NODE_ID);
    expect(entry.reason.startsWith(DECISION_CONFLICT_CLEARED_MARKER)).toBe(true);
    // The removed adr_ids and the preserved-intent fact are both named.
    expect(entry.reason).toContain('ADR-0017');
    expect(entry.reason).toContain('ADR-0020');
    expect(entry.reason).toContain('intent');
    // Normal, non-blocking record — never an escalation.
    expect(entry.decision).not.toBe('escalate');
  });

  test('[] with method/prefer-only entries removes the carrier file and logs the removal', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [methodRequire, preferIntent]);
    await apply(root, []);
    expect(await fileExists(carrierPath(root))).toBe(false);
    const log = await readDecisionLog(root);
    expect(log).toHaveLength(1);
    expect(String(log[0]?.reason)).toContain(DECISION_CONFLICT_CLEARED_MARKER);
    expect(String(log[0]?.reason)).toContain('removed');
  });

  test('[] twice is idempotent — the second run tolerates ENOENT and logs nothing new', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [methodRequire]);
    await apply(root, []);
    expect(await fileExists(carrierPath(root))).toBe(false);
    // Re-dispatch of the same node: must not throw, must not double-log.
    await apply(root, []);
    expect(await fileExists(carrierPath(root))).toBe(false);
    expect(await readDecisionLog(root)).toHaveLength(1);
  });

  test('[] with intent-only entries changes nothing and logs nothing (no removal happened)', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [intentForbid]);
    const before = await readFile(carrierPath(root), 'utf8');
    await apply(root, []);
    expect(await readFile(carrierPath(root), 'utf8')).toBe(before);
    expect(await readDecisionLog(root)).toHaveLength(0);
  });

  test('undefined (no judgment) leaves a pre-existing carrier byte-identical, no log', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [intentForbid, methodRequire]);
    const before = await readFile(carrierPath(root), 'utf8');
    await apply(root, undefined);
    expect(await readFile(carrierPath(root), 'utf8')).toBe(before);
    expect(await readDecisionLog(root)).toHaveLength(0);
  });
});

describe('applyDecisionConflictDeclaration — non-empty declaration (merge by adr_id)', () => {
  test('re-declaring the same adr_id preserves the existing resolution record (no clobber)', async () => {
    const root = await makeRoot();
    const resolution = {
      superseded_by: 'ADR-20260722-successor',
      basis: 'user-gated supersede landed; re-judged against the successor',
    };
    await seedCarrier(root, [{ ...intentForbid, resolution }]);
    await apply(root, [
      { ...intentForbid, basis: 're-judged basis after the supersede' },
      methodRequire,
    ]);
    const carrier = await readCarrierRaw(root);
    const rejudged = carrier.conflicts.find((c) => c.adr_id === 'ADR-0011');
    expect(rejudged?.basis).toBe('re-judged basis after the supersede');
    expect(rejudged?.resolution).toEqual(resolution);
    const fresh = carrier.conflicts.find((c) => c.adr_id === 'ADR-0017');
    expect(fresh).toBeDefined();
    expect(fresh?.resolution).toBeUndefined();
  });

  test('non-empty declaration with no pre-existing carrier writes it fresh', async () => {
    const root = await makeRoot();
    await apply(root, [methodRequire]);
    const carrier = await readCarrierRaw(root);
    expect(carrier.mode).toBe('autopilot');
    expect(carrier.conflicts.map((c) => c.adr_id)).toEqual(['ADR-0017']);
  });
});

describe('intentConflictPassCloseBlocker — done pass-close gate', () => {
  test('unresolved intent-level conflict refuses, naming the ADR and the user-owned exits', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [intentForbid, methodRequire]);
    const block = await intentConflictPassCloseBlocker(root, WI);
    expect(block).not.toBeNull();
    expect(block).toContain('ADR-0011');
    // The legitimate exits are framed as user decisions: supersede-resolution or abandon.
    expect(block).toMatch(/supersede/i);
    expect(block).toMatch(/abandon/i);
  });

  test('HEAD-verified resolved intent conflict (committed superseded ADR) does not block', async () => {
    // The resolution claim must be backed by POSITIVE evidence: the conflicting
    // ADR's status line at the HEAD commit reads superseded-by-the-claimed-successor.
    const root = await makeGitRoot();
    await commitAdrFile(root, 'ADR-0011-fixture.md', SUPERSEDED_ADR_0011_BODY);
    await seedCarrier(root, [{ ...intentForbid, resolution: verifiedResolution }]);
    expect(await intentConflictPassCloseBlocker(root, WI)).toBeNull();
  });

  test('resolution claim with NO verifiable evidence (no git repo) refuses (fail-closed)', async () => {
    // A bare `resolution` field is a CLAIM — with no git repo the HEAD read is
    // impossible, so the claim must NOT demote the block (field presence ≠ proof).
    const root = await makeRoot();
    await seedCarrier(root, [{ ...intentForbid, resolution: verifiedResolution }]);
    const block = await intentConflictPassCloseBlocker(root, WI);
    expect(block).not.toBeNull();
    expect(block).toContain('ADR-0011');
  });

  test('resolution claim against a still-accepted committed ADR refuses (fail-closed)', async () => {
    // The ADR file exists at HEAD but its status line is still accepted — the
    // supersede never landed, so the claimed resolution fails verification.
    const root = await makeGitRoot();
    await commitAdrFile(root, 'ADR-0011-fixture.md', ACCEPTED_ADR_0011_BODY);
    await seedCarrier(root, [{ ...intentForbid, resolution: verifiedResolution }]);
    const block = await intentConflictPassCloseBlocker(root, WI);
    expect(block).not.toBeNull();
    expect(block).toContain('ADR-0011');
  });

  test('absent carrier does not block', async () => {
    const root = await makeRoot();
    expect(await intentConflictPassCloseBlocker(root, WI)).toBeNull();
  });

  test('method/prefer-only carrier does not block', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [methodRequire, preferIntent]);
    expect(await intentConflictPassCloseBlocker(root, WI)).toBeNull();
  });

  test('malformed carrier refuses (fail-closed)', async () => {
    const root = await makeRoot();
    await mkdir(wiDir(root), { recursive: true });
    await writeFile(carrierPath(root), 'not-json {{{', 'utf8');
    const block = await intentConflictPassCloseBlocker(root, WI);
    expect(block).not.toBeNull();
    expect(block).toMatch(/malformed/i);
  });
});

describe('planRequiresDecisionApproval — plan front-load consumes the EFFECTIVE blocking set', () => {
  test('unresolved intent conflict front-loads the approval gate (true)', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [intentForbid]);
    expect(await planRequiresDecisionApproval(root, WI)).toBe(true);
  });

  test('HEAD-verified resolved intent conflict no longer force-pends the plan gate (false)', async () => {
    // F2: RAW conflicts must not reach decisionConflictRequiresApproval — the
    // verified-resolved entry is demoted out of the blocking set first, so a
    // landed supersede stops front-loading the approval gate.
    const root = await makeGitRoot();
    await commitAdrFile(root, 'ADR-0011-fixture.md', SUPERSEDED_ADR_0011_BODY);
    await seedCarrier(root, [{ ...intentForbid, resolution: verifiedResolution }]);
    expect(await planRequiresDecisionApproval(root, WI)).toBe(false);
  });

  test('unverifiable resolution claim (no git repo) still front-loads (fail-closed, true)', async () => {
    const root = await makeRoot();
    await seedCarrier(root, [{ ...intentForbid, resolution: verifiedResolution }]);
    expect(await planRequiresDecisionApproval(root, WI)).toBe(true);
  });
});

// ── CLI wiring: `ditto work done` refuses the pass-close on an unresolved intent conflict ──

type RunHandler = (ctx: { args: Record<string, unknown> }) => Promise<void> | void;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Drive the `work done` citty run() handler directly; capture stderr + exit code. */
async function runDone(workId: string): Promise<{ err: string; exitCode: number }> {
  const sub = (workCommand as unknown as { subCommands: Record<string, { run?: RunHandler }> })
    .subCommands;
  const run = sub.done?.run;
  if (!run) throw new Error('work done subcommand has no run handler');
  const errChunks: string[] = [];
  const decode = (c: unknown): string =>
    typeof c === 'string' ? c : new TextDecoder().decode(c as Uint8Array);
  const so = spyOn(process.stdout, 'write').mockImplementation(
    ((_c: unknown) => true) as unknown as typeof process.stdout.write,
  );
  const se = spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
    errChunks.push(decode(c));
    return true;
  }) as unknown as typeof process.stderr.write);
  const ex = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(typeof code === 'number' ? code : 0);
  }) as unknown as typeof process.exit);
  let exitCode = 0;
  try {
    await run({ args: { workId, output: 'human' } });
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else throw e;
  } finally {
    so.mockRestore();
    se.mockRestore();
    ex.mockRestore();
  }
  return { err: errChunks.join(''), exitCode };
}

describe('ditto work done wiring — intent-conflict pass-close seam', () => {
  test('unresolved intent conflict in the carrier refuses the pass-close', async () => {
    const root = await makeRoot();
    const item = await new WorkItemStore(root).create({
      title: 'fixture',
      source_request: 'fixture',
      goal: 'fixture',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'a real criterion', verdict: 'unverified', evidence: [] },
      ],
    });
    await seedCarrier(root, [intentForbid], item.id);
    process.chdir(root);
    const { err, exitCode } = await runDone(item.id);
    expect(exitCode).not.toBe(0);
    expect(err).toContain('cannot close');
    expect(err).toContain('ADR-0011');
  });

  test('method-only carrier does not trip the conflict gate (done proceeds to later gates)', async () => {
    const root = await makeRoot();
    const item = await new WorkItemStore(root).create({
      title: 'fixture',
      source_request: 'fixture',
      goal: 'fixture',
      acceptance_criteria: [
        { id: 'ac-1', statement: PLACEHOLDER_AC_STATEMENT, verdict: 'unverified', evidence: [] },
      ],
    });
    await seedCarrier(root, [methodRequire], item.id);
    process.chdir(root);
    const { err, exitCode } = await runDone(item.id);
    // It still refuses — but at the LATER placeholder-AC gate, not the conflict gate:
    // proof the method-only carrier has no effect on the done path.
    expect(exitCode).not.toBe(0);
    expect(err).toContain('placeholder acceptance criteria');
    expect(err).not.toContain('ADR-0017');
  });
});
