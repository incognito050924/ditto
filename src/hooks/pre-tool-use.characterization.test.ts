import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FixtureId, PARITY_CASES, type ParityContext } from './parity-cases';
import { preToolUseHandler as legacyPreToolUseHandler } from './pre-tool-use';
import { preToolUseHandler as rebuiltPreToolUseHandler } from './rebuilt/pre-tool-use';
import { windowsDestructiveReason } from './rebuilt/pre-tool-use-policy';

/**
 * Handler under test: the REBUILT handler by default (what the dispatch table
 * now routes), the legacy handler under DITTO_HOOKS_LEGACY=1 — the same env
 * flip `ditto hook` uses. Run BOTH paths to prove decision parity:
 *   bun test src/hooks/                       # rebuilt
 *   DITTO_HOOKS_LEGACY=1 bun test src/hooks/  # legacy
 */
const preToolUseHandler =
  process.env.DITTO_HOOKS_LEGACY === '1' ? legacyPreToolUseHandler : rebuiltPreToolUseHandler;

/**
 * PreToolUse CHARACTERIZATION tests — pin the legacy handler's observable
 * blocking decisions BEFORE any hook rewiring (the prior hook test suite was
 * deleted in commit 6f298c8; this is the replacement safety net).
 *
 * These tests must be GREEN against the CURRENT legacy handler: they assert
 * what the handler does TODAY, not what a redesign should do. The decision
 * cases live in the handler-agnostic `parity-cases.ts` table so the same
 * table can later run against rebuilt handlers by only swapping the handler
 * import above.
 *
 * The handler is invoked in-process with constructed HookInput envelopes
 * (the same shape `executeHook` builds from stdin) against per-fixture temp
 * repos — no live sessions, no writes to the real repo.
 */

const WI = 'wi_parity0001';
const SESSION = 'parity-session';
const NOW = () => new Date().toISOString();

const roots: string[] = [];
const contexts = new Map<FixtureId, ParityContext>();

function newRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const wiDir = (root: string) => join(root, '.ditto', 'local', 'work-items', WI);

/** Bind SESSION → WI the way SessionPointerStore persists it. */
function writeSessionPointer(root: string): void {
  writeJsonFile(join(root, '.ditto', 'local', 'sessions', `${SESSION}.json`), {
    schema_version: '0.1.0',
    session_id: SESSION,
    work_item_id: WI,
    updated_at: NOW(),
  });
}

function writeChangeContract(root: string, overrides: Record<string, unknown>): void {
  writeJsonFile(join(wiDir(root), 'change-contract.json'), {
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: WI,
    produced_by: 'agent',
    produced_at: NOW(),
    purpose: 'parity characterization fixture',
    invariants: [],
    acceptance: [{ criterion: 'parity fixture', evidence_kind: 'test' }],
    decision_ref: null,
    risk_default: 'low',
    ...overrides,
  });
}

/** Minimal valid autopilot.json with one implement node in the given status. */
function writeAutopilotGraph(root: string, nodeStatus: 'running' | 'passed'): void {
  writeJsonFile(join(wiDir(root), 'autopilot.json'), {
    schema_version: '0.1.0',
    autopilot_id: 'orch_parity0001',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'parity characterization fixture',
    completion_boundary: 'entire_work_item',
    approval_gate: { status: 'approved' },
    nodes: [
      {
        id: 'n1',
        kind: 'implement',
        owner: 'implementer',
        purpose: 'parity fixture node',
        status: nodeStatus,
      },
    ],
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
    stop_conditions: [],
  });
}

function writeLease(root: string, scopeSource: 'declared' | 'derived'): void {
  writeJsonFile(join(wiDir(root), 'active-leases.json'), {
    schema_version: '0.1.0',
    leases: [
      {
        node_id: 'n1',
        work_item_id: WI,
        file_scope: ['src/leased.ts'],
        scope_source: scopeSource,
        created_at: NOW(),
      },
    ],
  });
}

function buildFixture(id: FixtureId): ParityContext {
  const root = newRepo(`ditto-parity-${id}-`);
  switch (id) {
    case 'bare':
      break;
    case 'contract-blacklist':
      writeSessionPointer(root);
      writeChangeContract(root, {
        allowed_scope: [],
        forbidden_scope: [{ kind: 'path', ref: 'src/protected' }],
        scope_mode: 'blacklist',
      });
      break;
    case 'contract-whitelist':
      writeSessionPointer(root);
      writeChangeContract(root, {
        allowed_scope: [{ kind: 'path', ref: 'src/allowed' }],
        // schema requires a non-empty forbidden_scope even in whitelist mode
        forbidden_scope: [{ kind: 'path', ref: 'dist' }],
        scope_mode: 'whitelist',
      });
      break;
    case 'lease-active':
      writeSessionPointer(root);
      writeAutopilotGraph(root, 'running');
      writeLease(root, 'declared');
      break;
    case 'lease-derived':
      writeSessionPointer(root);
      writeAutopilotGraph(root, 'running');
      writeLease(root, 'derived');
      break;
    case 'lease-terminal':
      writeSessionPointer(root);
      writeAutopilotGraph(root, 'passed');
      writeLease(root, 'declared');
      break;
    case 'jvm-jar':
      mkdirSync(join(root, 'libs'), { recursive: true });
      writeFileSync(join(root, 'libs', 'sibling.jar'), 'not-a-real-jar');
      break;
    case 'jvm-jar-declared':
      mkdirSync(join(root, 'libs'), { recursive: true });
      writeFileSync(join(root, 'libs', 'sibling.jar'), 'not-a-real-jar');
      writeJsonFile(join(root, '.ditto', 'architecture-spec.json'), {
        schema_version: '0.1.0',
        kind: 'acg.architecture-spec.v1',
        produced_by: 'user',
        produced_at: NOW(),
        internal_packages: [
          { type: 'glob', value: 'com.acme.**' },
          { type: 'path', value: 'libs/*.jar' },
        ],
      });
      break;
  }
  return {
    repoRoot: root,
    home: process.env.HOME ?? homedir(),
    sessionId: SESSION,
    workItemId: WI,
  };
}

function ctxFor(id: FixtureId): ParityContext {
  let ctx = contexts.get(id);
  if (!ctx) {
    ctx = buildFixture(id);
    contexts.set(id, ctx);
  }
  return ctx;
}

// The handler reads process.env.DITTO_AUTOPILOT_BYPASS directly (in addition to
// input.env); neutralize any ambient value so the lease block cases are stable.
// Only the exact string '1' activates the bypass, so '0' is inert.
let savedBypass: string | undefined;
beforeAll(() => {
  savedBypass = process.env.DITTO_AUTOPILOT_BYPASS;
  process.env.DITTO_AUTOPILOT_BYPASS = '0';
});

afterAll(() => {
  if (savedBypass !== undefined) process.env.DITTO_AUTOPILOT_BYPASS = savedBypass;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('PreToolUse characterization — parity decision table', () => {
  for (const c of PARITY_CASES) {
    const runner = c.skipOnWindows && process.platform === 'win32' ? test.skip : test;
    runner(`[${c.category}] ${c.name}`, async () => {
      const ctx = ctxFor(c.fixture);
      const raw = typeof c.raw === 'function' ? c.raw(ctx) : c.raw;
      const out = await preToolUseHandler({
        raw,
        repoRoot: ctx.repoRoot,
        env: c.env ?? {},
        ...(c.host !== undefined ? { host: c.host } : {}),
      });
      expect(out.exitCode).toBe(c.expected.exitCode);
      if (c.expected.stderrIncludes !== undefined) {
        expect(out.stderr ?? '').toContain(c.expected.stderrIncludes);
      }
    });
  }
});

// The Windows destructive mirror is platform-gated inside the handler (it only
// evaluates when the runtime is win32), so its POLICY is pinned through the
// exported pure helper rather than the envelope table. The rebuilt policy
// module re-exports the SAME function, so this pins both handler generations.
describe('PreToolUse characterization — Windows destructive mirror (pure policy)', () => {
  const home = 'C:\\Users\\me';

  test('recursive delete of a drive root is a block reason', () => {
    expect(windowsDestructiveReason('rd /s /q c:\\', home)).toContain('drive root');
  });

  test('format of a drive is a block reason', () => {
    expect(windowsDestructiveReason('format d:', home)).toContain('format');
  });

  test('recursive Remove-Item of an absolute path outside home is a block reason', () => {
    expect(
      windowsDestructiveReason('Remove-Item -Recurse -Force C:\\Users\\other\\proj', home),
    ).toContain('outside home');
  });

  test('recursive delete of a relative path is allowed (assumed in-repo)', () => {
    expect(windowsDestructiveReason('rd /s /q build', home)).toBeNull();
  });

  test('recursive delete inside home is allowed', () => {
    expect(
      windowsDestructiveReason('Remove-Item -Recurse -Force C:\\Users\\me\\proj', home),
    ).toBeNull();
  });
});
