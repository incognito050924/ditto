import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseJvmCodeqlCommand, runInternalPackagesGuard } from '~/acg/internal-packages';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { AutopilotStore } from '~/core/autopilot-store';
import { ChangeContractStore } from '~/core/change-contract-store';
import { atomicWriteText, ensureDir, readArchitectureSpec } from '~/core/fs';
import { SessionPointerStore } from '~/core/session-pointer';
import { type AcgArchitectureSpec, acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { mutatedPaths, parseApplyPatchPaths } from '../envelope';
import type { HookHandler, HookInput } from '../runtime';
import {
  type PreToolDecision,
  bashSecretExposure,
  bashWriteTargets,
  contractScopeDecision,
  destructiveCommandDecision,
  isClaudeMemoryPath,
  isOutsideRepo,
  isSecretPath,
  isSystemTmpPath,
  leaseGateDecision,
  leaseScopeRelPath,
  shellRunsApplyPatch,
} from './pre-tool-use-policy';

/**
 * PreToolUse safety hook — rebuilt thin shell (increment 3). All decision policy
 * lives in the PURE module `./pre-tool-use-policy.ts`; this shell only parses
 * the envelope, loads persisted state (session pointer / contract / autopilot
 * graph / leases), and renders decisions. Fail-open guarantees
 * (DITTO_SKIP_HOOKS, handler crash) live in the `runHook` wrapper — this body
 * does NOT re-check the kill-switch and does NOT self-wrap in try/catch.
 *
 * Default is ALLOW: an unmatched tool, or a missing/non-string field, never
 * blocks.
 */

// Windows has no $HOME; it exposes the home directory as %USERPROFILE%.
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '';
const IS_WIN = process.platform === 'win32';

const ALLOW_OUT = { exitCode: 0 } as const;

function render(decision: PreToolDecision) {
  if (decision.verdict === 'allow') return ALLOW_OUT;
  return {
    exitCode: 2,
    stderr: `DITTO PreToolUse: blocked ${decision.category} — ${decision.reason}. Set DITTO_SKIP_HOOKS=1 to bypass.\n`,
  };
}

function isCommandTool(input: HookInput, toolName: unknown): boolean {
  return toolName === 'Bash' || (input.host === 'codex' && toolName === 'exec_command');
}

function commandToolInput(
  input: HookInput,
  toolName: unknown,
  toolInput: Record<string, unknown>,
): string | undefined {
  if (typeof toolInput.command === 'string') return toolInput.command;
  if (input.host === 'codex' && toolName === 'exec_command' && typeof toolInput.cmd === 'string') {
    return toolInput.cmd;
  }
  return undefined;
}

/** `.ditto/architecture-spec.json` optional load (absent/invalid → undefined). */
async function loadArchSpec(repoRoot: string): Promise<AcgArchitectureSpec | undefined> {
  try {
    return await readArchitectureSpec(
      resolve(repoRoot, '.ditto', 'architecture-spec.json'),
      acgArchitectureSpec,
    );
  } catch {
    return undefined;
  }
}

function runtimeHome(): string {
  return process.env.HOME ?? homedir();
}

/** Explicit bypass affordance, DISTINCT from DITTO_SKIP_HOOKS. */
function autopilotBypassActive(input: HookInput): boolean {
  const env = input.env ?? {};
  return env.DITTO_AUTOPILOT_BYPASS === '1' || process.env.DITTO_AUTOPILOT_BYPASS === '1';
}

/** Append exactly one audit record per bypassed out-of-scope edit. */
async function appendBypassRecord(repoRoot: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(repoRoot, '.ditto');
  await ensureDir(dir);
  const path = join(dir, 'autopilot-bypass.jsonl');
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(entry)}\n`);
}

/**
 * ChangeContract scope gate over one edit path. All absent preconditions
 * (no session / no pointer / no contract) fall through to undefined → ALLOW.
 */
async function checkForbiddenScope(
  input: HookInput,
  filePath: string,
): Promise<PreToolDecision | undefined> {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return undefined;

  const workItemId = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!workItemId) return undefined;

  const contract = await new ChangeContractStore(input.repoRoot).read(workItemId);
  if (!contract) return undefined;

  // Worktree-aware relativization shared with the lease gate, so a worktree
  // edit's `.ditto/local/worktrees/<wi>/` prefix never false-blocks a whitelist
  // or under-enforces a blacklist.
  const repoRel = leaseScopeRelPath(input.repoRoot, filePath);
  const archSpec = await loadArchSpec(input.repoRoot);
  return contractScopeDecision(contract, repoRel, archSpec);
}

/**
 * Autopilot active-node lease gate over one edit path. The shell loads the
 * graph + leases and fail-opens on every absent precondition; the pure policy
 * decides scope containment / bypass. A bypass-allow appends the audit record.
 */
async function checkAutopilotLease(
  input: HookInput,
  filePath: string,
): Promise<PreToolDecision | undefined> {
  // A write OUTSIDE the repo into system tmp (harness scratchpads) is not a repo
  // mutation, so the lease allow-list has no say over it.
  if (isOutsideRepo(input.repoRoot, filePath) && isSystemTmpPath(filePath)) return undefined;

  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return undefined; // fail-open: untracked session

  const workItemId = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!workItemId) return undefined; // fail-open: no active work item

  const aps = new AutopilotStore(input.repoRoot);
  if (!(await aps.exists(workItemId))) return undefined; // fail-open: not under autopilot
  let graph: Awaited<ReturnType<AutopilotStore['get']>>;
  try {
    graph = await aps.get(workItemId);
  } catch {
    return undefined; // fail-open: unreadable graph
  }

  const leases = await new ActiveNodeLeaseStore(input.repoRoot).listActive(workItemId);
  const repoRel = leaseScopeRelPath(input.repoRoot, filePath);
  const decision = leaseGateDecision({
    repoRel,
    leases,
    nodes: graph.nodes,
    bypassActive: autopilotBypassActive(input),
  });

  if (decision.verdict === 'allow') return undefined;
  if (decision.verdict === 'bypass-allow') {
    await appendBypassRecord(input.repoRoot, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      work_item_id: workItemId,
      file_path: repoRel,
      active_leases: leases.map((l) => l.node_id),
    });
    return undefined;
  }
  return decision;
}

/**
 * The full mutation gate sequence for one path: secret (read+write), scope-out
 * write, ChangeContract scope, autopilot lease. Returns a block decision on the
 * first violation, undefined to allow.
 */
async function checkMutatedPath(
  input: HookInput,
  filePath: string,
): Promise<PreToolDecision | undefined> {
  if (isSecretPath(filePath)) {
    return {
      verdict: 'block',
      category: 'secret',
      reason: `access to a secret file (${filePath})`,
    };
  }
  if (
    isOutsideRepo(input.repoRoot, filePath) &&
    !isClaudeMemoryPath(input.repoRoot, filePath, runtimeHome()) &&
    !isSystemTmpPath(filePath)
  ) {
    return { verdict: 'block', category: 'scope-out', reason: `write outside repo (${filePath})` };
  }
  const forbidden = await checkForbiddenScope(input, filePath);
  if (forbidden) return forbidden;
  return checkAutopilotLease(input, filePath);
}

export const preToolUseHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const toolName = raw.tool_name;
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  const repoRoot = input.repoRoot;

  // --- Codex write_stdin carrying apply_patch content ---------------------
  if (input.host === 'codex' && toolName === 'write_stdin') {
    const chars = typeof toolInput.chars === 'string' ? toolInput.chars : undefined;
    if (!chars) return ALLOW_OUT;
    for (const path of parseApplyPatchPaths(chars)) {
      const verdict = await checkMutatedPath(input, path);
      if (verdict) return render(verdict);
    }
    return ALLOW_OUT;
  }

  // --- Shell commands -----------------------------------------------------
  if (isCommandTool(input, toolName)) {
    const command = commandToolInput(input, toolName, toolInput);
    if (!command) return ALLOW_OUT;

    if (input.host === 'codex' && shellRunsApplyPatch(command)) {
      return render({
        verdict: 'block',
        category: 'apply-patch-bypass',
        reason: 'shell command runs apply_patch outside the Codex apply_patch tool gate',
      });
    }

    const destructive = destructiveCommandDecision(command, { home: HOME, isWindows: IS_WIN });
    if (destructive.verdict === 'block') return render(destructive);

    // Secret-file exposure inside a Bash command — verb-aware default-deny.
    const exposed = bashSecretExposure(command);
    if (exposed !== undefined) {
      return render({
        verdict: 'block',
        category: 'secret',
        reason: `command exposes a secret file (${exposed})`,
      });
    }

    // Best-effort static redirect / copy destinations: outside-repo writes block
    // unless they land in the Claude auto-memory dir or system tmp; the tmp
    // allowance EXCLUDES secret-shaped targets (secret > tmp-allow).
    for (const dest of bashWriteTargets(command)) {
      const tmpAllowed = isSystemTmpPath(dest) && !isSecretPath(dest);
      if (
        isOutsideRepo(repoRoot, dest) &&
        !isClaudeMemoryPath(repoRoot, dest, runtimeHome()) &&
        !tmpAllowed
      ) {
        return render({
          verdict: 'block',
          category: 'scope-out',
          reason: `write outside repo (${dest})`,
        });
      }
    }

    // JVM CodeQL cross_repo guard — block a `ditto impact|boundary --language
    // java|kotlin` run when local JARs exist with an internal_packages gap.
    const jvm = parseJvmCodeqlCommand(command);
    if (jvm) {
      const spec = await loadArchSpec(repoRoot);
      const sourceRoot = jvm.sourceRoot ? resolve(repoRoot, jvm.sourceRoot) : repoRoot;
      const guard = await runInternalPackagesGuard({
        language: 'java',
        entries: spec?.internal_packages ?? [],
        sourceRoot,
      });
      if (guard.decision === 'block') {
        return render({ verdict: 'block', category: 'internal-packages', reason: guard.reason });
      }
    }

    return ALLOW_OUT;
  }

  // --- Codex apply_patch (host=codex only) --------------------------------
  if (input.host === 'codex' && toolName === 'apply_patch') {
    for (const path of mutatedPaths('codex', raw)) {
      const verdict = await checkMutatedPath(input, path);
      if (verdict) return render(verdict);
    }
    return ALLOW_OUT;
  }

  // --- File tools ---------------------------------------------------------
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  if (!filePath) return ALLOW_OUT;

  // Secret file — read AND write both block.
  if (isSecretPath(filePath)) {
    return render({
      verdict: 'block',
      category: 'secret',
      reason: `access to a secret file (${filePath})`,
    });
  }

  // Scope-out + contract + lease gates apply to WRITES only.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    if (
      isOutsideRepo(repoRoot, filePath) &&
      !isClaudeMemoryPath(repoRoot, filePath, runtimeHome()) &&
      !isSystemTmpPath(filePath)
    ) {
      return render({
        verdict: 'block',
        category: 'scope-out',
        reason: `write outside repo (${filePath})`,
      });
    }
    const forbidden = await checkForbiddenScope(input, filePath);
    if (forbidden) return render(forbidden);
    const offPath = await checkAutopilotLease(input, filePath);
    if (offPath) return render(offPath);
  }

  return ALLOW_OUT;
};
