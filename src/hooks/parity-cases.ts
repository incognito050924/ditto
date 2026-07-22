import { resolve } from 'node:path';

/**
 * Shared, HANDLER-AGNOSTIC decision-case table for the PreToolUse hook
 * characterization (parity) tests.
 *
 * WHY THIS EXISTS: the legacy hook test suite was deleted (commit 6f298c8)
 * before the hook rebuild. These cases pin the CURRENT legacy handlers'
 * observable blocking decisions — the safety net the rebuild is judged
 * against. The SAME table must later run unchanged against the rebuilt
 * handlers, so this module deliberately imports NOTHING from any handler
 * module (`pre-tool-use.ts` etc.); it is pure data + tiny path helpers.
 *
 * Each case is one observable decision: an event input envelope (the raw
 * stdin JSON a host would send) plus the expected exit code and, for blocks,
 * a stderr substring. Every block category carries at least one blocking case
 * AND one adjacent allow case (the nearest input that must NOT block), so a
 * rebuilt handler that over- or under-blocks fails the table either way.
 *
 * Fixture ids name the temp-repo state a case needs (session pointer, change
 * contract, autopilot lease, sibling JAR); the test runner materializes them
 * under a temp dir — never against the real repo.
 */

export interface ParityContext {
  /** Absolute path of the temp repo the case runs against. */
  repoRoot: string;
  /** The runtime HOME dir (drives the claude-memory / rm-inside-home cases). */
  home: string;
  /** Session id the fixture bound to `workItemId` via a session pointer. */
  sessionId: string;
  /** Work item id the fixture's contract / autopilot state belongs to. */
  workItemId: string;
}

export type FixtureId =
  | 'bare'
  | 'contract-blacklist'
  | 'contract-whitelist'
  | 'lease-active'
  | 'lease-derived'
  | 'lease-terminal'
  | 'jvm-jar'
  | 'jvm-jar-declared';

export interface ParityExpectation {
  exitCode: 0 | 2;
  /** Substring the block message must carry (block cases only). */
  stderrIncludes?: string;
}

export interface ParityCase {
  name: string;
  /** Decision family — one per distinct block/deny call site in the handler. */
  category: string;
  fixture: FixtureId;
  /** Host whose envelope shape feeds the handler; defaults to claude-code. */
  host?: 'claude-code' | 'codex';
  /** Env passed as HookInput.env (e.g. the autopilot bypass affordance). */
  env?: Record<string, string>;
  /** Raw stdin envelope, or a builder when the case depends on fixture paths. */
  raw: Record<string, unknown> | ((ctx: ParityContext) => Record<string, unknown>);
  expected: ParityExpectation;
  /**
   * The expectation is only valid OFF Windows (the legacy handler gates its
   * Windows destructive-primitive mirror on the runtime platform).
   */
  skipOnWindows?: boolean;
}

const bash = (command: string): Record<string, unknown> => ({
  tool_name: 'Bash',
  tool_input: { command },
});

const fileTool = (
  tool: 'Read' | 'Write' | 'Edit' | 'MultiEdit',
  filePath: string,
): Record<string, unknown> => ({ tool_name: tool, tool_input: { file_path: filePath } });

/** The current project's Claude Code auto-memory path (the ONE allowed subtree). */
export function claudeMemoryPath(ctx: ParityContext, rel: string): string {
  const slug = resolve(ctx.repoRoot).replace(/[^a-zA-Z0-9]/g, '-');
  return resolve(ctx.home, '.claude', 'projects', slug, 'memory', rel);
}

export const PARITY_CASES: ParityCase[] = [
  // ── destructive Bash primitives ────────────────────────────────────────────
  {
    name: 'fork bomb blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash(':(){ :|:& };:'),
    expected: { exitCode: 2, stderrIncludes: 'fork bomb' },
  },
  {
    name: 'ordinary shell function definition allows (fork-bomb adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('f(){ echo hi; }; f'),
    expected: { exitCode: 0 },
  },
  {
    name: 'mkfs on a device blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('mkfs.ext4 /dev/sda1'),
    expected: { exitCode: 2, stderrIncludes: 'mkfs' },
  },
  {
    name: 'mkdir allows (mkfs adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('mkdir -p build/out'),
    expected: { exitCode: 0 },
  },
  {
    name: 'dd writing to a device blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('dd if=/dev/zero of=/dev/sda'),
    expected: { exitCode: 2, stderrIncludes: 'dd to a device' },
  },
  {
    name: 'dd writing to a repo-local file allows (dd adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('dd if=/dev/zero of=./scratch.img bs=1024 count=1'),
    expected: { exitCode: 0 },
  },
  {
    name: 'redirect onto a block device blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('echo junk > /dev/sda1'),
    expected: { exitCode: 2, stderrIncludes: 'block device' },
  },
  {
    name: 'redirect onto a repo-local file allows (block-device adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('echo ok > notes.txt'),
    expected: { exitCode: 0 },
  },
  {
    name: 'sudo with a destructive command blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('sudo rm -rf build'),
    expected: { exitCode: 2, stderrIncludes: 'sudo' },
  },
  {
    name: 'quoted "sudo rm" inside a commit message allows (sudo adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('git commit -m "cleanup: remove sudo rm usage from docs"'),
    expected: { exitCode: 0 },
  },
  {
    name: 'force-push to main blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('git push --force origin main'),
    expected: { exitCode: 2, stderrIncludes: 'force-push' },
  },
  {
    name: 'force-push to a feature branch allows (force-push adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('git push --force origin feat/parity'),
    expected: { exitCode: 0 },
  },
  {
    name: 'plain push to main allows (force-push adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('git push origin main'),
    expected: { exitCode: 0 },
  },
  {
    name: 'rm -rf / blocks (literal root wipe)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('rm -rf /'),
    expected: { exitCode: 2, stderrIncludes: 'root/home' },
  },
  {
    name: 'rm -rf of an absolute path outside repo/home blocks',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('rm -rf /opt/some-cache'),
    expected: { exitCode: 2, stderrIncludes: 'outside repo/home' },
  },
  {
    name: 'rm -rf of a relative path allows (assumed in-repo, rm adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: bash('rm -rf node_modules'),
    expected: { exitCode: 0 },
  },
  {
    name: 'rm -rf inside home allows (rm adjacent)',
    category: 'destructive',
    fixture: 'bare',
    raw: (ctx) => bash(`rm -rf ${resolve(ctx.home, '.cache', 'ditto-parity')}`),
    expected: { exitCode: 0 },
  },
  {
    // The legacy handler evaluates its Windows destructive mirror ONLY when the
    // runtime platform is win32; on a POSIX runtime the same command text is
    // allowed. The mirror policy itself is pinned separately via the exported
    // pure helper in the characterization test.
    name: 'windows drive-root delete text allows on a POSIX runtime (IS_WIN gate)',
    category: 'destructive-windows',
    fixture: 'bare',
    raw: bash('rd /s /q c:\\'),
    expected: { exitCode: 0 },
    skipOnWindows: true,
  },

  // ── no-verify push gate ────────────────────────────────────────────────────
  {
    name: 'git push --no-verify blocks',
    category: 'no-verify-push',
    fixture: 'bare',
    raw: bash('git push --no-verify origin HEAD'),
    expected: { exitCode: 2, stderrIncludes: 'no-verify-push' },
  },
  {
    name: 'quoted "git push --no-verify" in a commit message allows (adjacent)',
    category: 'no-verify-push',
    fixture: 'bare',
    raw: bash('git commit -m "docs: never use git push --no-verify"'),
    expected: { exitCode: 0 },
  },

  // ── secret access via Bash operands (default-deny) ─────────────────────────
  {
    name: 'cat .env blocks',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('cat .env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'stdin redirect from .env blocks',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('wc -l < .env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'unknown verb with a secret operand blocks (default-deny)',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('sort .env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'grep with a secret FILE operand blocks',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('grep AWS_SECRET .env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'secret under tmp still blocks (secret beats the tmp allowance)',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('cat /tmp/.env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'metadata verb on .env allows (ls, adjacent)',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('ls -la .env'),
    expected: { exitCode: 0 },
  },
  {
    name: 'template-suffixed .env.example allows (adjacent)',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('cat .env.example'),
    expected: { exitCode: 0 },
  },
  {
    name: 'grep with a secret-shaped SEARCH PATTERN allows (adjacent)',
    category: 'secret-bash',
    fixture: 'bare',
    raw: bash('grep -r "id_rsa" src/'),
    expected: { exitCode: 0 },
  },

  // ── secret access via file tools (read AND write) ──────────────────────────
  {
    name: 'Read of .env blocks',
    category: 'secret-file',
    fixture: 'bare',
    raw: fileTool('Read', '.env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'Write of a credentials file blocks',
    category: 'secret-file',
    fixture: 'bare',
    raw: fileTool('Write', 'config/credentials.json'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'Write of a secret path under tmp blocks (secret beats tmp allowance)',
    category: 'secret-file',
    fixture: 'bare',
    raw: fileTool('Write', '/tmp/.env'),
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'Read of .env.example allows (template suffix, adjacent)',
    category: 'secret-file',
    fixture: 'bare',
    raw: fileTool('Read', '.env.example'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Write of a non-secret env-named source file allows (adjacent)',
    category: 'secret-file',
    fixture: 'bare',
    raw: fileTool('Write', 'src/env-config.ts'),
    expected: { exitCode: 0 },
  },

  // ── scope-out writes via file tools ────────────────────────────────────────
  {
    name: 'Write outside the repo blocks',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: fileTool('Write', '/etc/ditto-parity-scope-out.txt'),
    expected: { exitCode: 2, stderrIncludes: 'scope-out' },
  },
  {
    name: 'Write to another project’s claude memory dir blocks',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: (ctx) =>
      fileTool(
        'Write',
        resolve(ctx.home, '.claude', 'projects', 'some-other-project', 'memory', 'notes.md'),
      ),
    expected: { exitCode: 2, stderrIncludes: 'scope-out' },
  },
  {
    name: 'Write inside the repo allows (adjacent)',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: fileTool('Write', 'src/inside.ts'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Read outside the repo allows (only writes are scope-gated)',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: fileTool('Read', '/etc/hosts'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Write under system tmp allows (tmp exception)',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: fileTool('Write', '/private/tmp/ditto-parity-scratch.txt'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Write into THIS project’s claude memory dir allows (memory exception)',
    category: 'scope-out-file',
    fixture: 'bare',
    raw: (ctx) => fileTool('Write', claudeMemoryPath(ctx, 'notes.md')),
    expected: { exitCode: 0 },
  },

  // ── scope-out writes via Bash redirect / copy destinations ─────────────────
  {
    name: 'Bash redirect outside the repo blocks',
    category: 'scope-out-bash',
    fixture: 'bare',
    raw: bash('echo hi > /etc/ditto-parity.txt'),
    expected: { exitCode: 2, stderrIncludes: 'scope-out' },
  },
  {
    name: 'cp with a destination outside the repo blocks',
    category: 'scope-out-bash',
    fixture: 'bare',
    raw: bash('cp notes.txt /etc/ditto-parity.txt'),
    expected: { exitCode: 2, stderrIncludes: 'scope-out' },
  },
  {
    name: 'Bash redirect inside the repo allows (adjacent)',
    category: 'scope-out-bash',
    fixture: 'bare',
    raw: bash('echo hi > out/log.txt'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Bash redirect under system tmp allows (tmp exception)',
    category: 'scope-out-bash',
    fixture: 'bare',
    raw: bash('echo hi > /tmp/ditto-parity.txt'),
    expected: { exitCode: 0 },
  },
  {
    name: 'Bash redirect into THIS project’s claude memory dir allows',
    category: 'scope-out-bash',
    fixture: 'bare',
    raw: (ctx) => bash(`echo note > ${claudeMemoryPath(ctx, 'log.md')}`),
    expected: { exitCode: 0 },
  },

  // ── ChangeContract blacklist mode (forbidden_scope) ────────────────────────
  {
    name: 'edit inside forbidden_scope blocks (blacklist mode)',
    category: 'contract-blacklist',
    fixture: 'contract-blacklist',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/protected/core.ts'),
    }),
    expected: { exitCode: 2, stderrIncludes: 'forbidden-scope' },
  },
  {
    name: 'edit outside forbidden_scope allows (blacklist adjacent)',
    category: 'contract-blacklist',
    fixture: 'contract-blacklist',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/open/feature.ts'),
    }),
    expected: { exitCode: 0 },
  },

  // ── ChangeContract whitelist mode (allowed_scope only) ─────────────────────
  {
    name: 'edit outside allowed_scope blocks (whitelist mode)',
    category: 'contract-whitelist',
    fixture: 'contract-whitelist',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/not-allowed.ts'),
    }),
    expected: { exitCode: 2, stderrIncludes: 'tidy-scope' },
  },
  {
    name: 'edit inside allowed_scope allows (whitelist adjacent)',
    category: 'contract-whitelist',
    fixture: 'contract-whitelist',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/allowed/mod.ts'),
    }),
    expected: { exitCode: 0 },
  },

  // ── autopilot active-node lease allow-list ─────────────────────────────────
  {
    name: 'edit outside every active lease file_scope blocks',
    category: 'autopilot-lease',
    fixture: 'lease-active',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/unleased.ts'),
    }),
    expected: { exitCode: 2, stderrIncludes: 'autopilot-path' },
  },
  {
    name: 'edit inside the active lease file_scope allows',
    category: 'autopilot-lease',
    fixture: 'lease-active',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/leased.ts'),
    }),
    expected: { exitCode: 0 },
  },
  {
    name: 'tests/** companion edit allows while a mutating node is leased',
    category: 'autopilot-lease',
    fixture: 'lease-active',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'tests/companion.test.ts'),
    }),
    expected: { exitCode: 0 },
  },
  {
    name: 'DITTO_AUTOPILOT_BYPASS=1 overrides the lease block (audited bypass)',
    category: 'autopilot-lease',
    fixture: 'lease-active',
    env: { DITTO_AUTOPILOT_BYPASS: '1' },
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/unleased.ts'),
    }),
    expected: { exitCode: 0 },
  },
  {
    name: 'no session_id in the envelope fails open (lease precondition)',
    category: 'autopilot-lease',
    fixture: 'lease-active',
    raw: fileTool('Write', 'src/unleased.ts'),
    expected: { exitCode: 0 },
  },
  {
    name: 'derived-scope lease fails open (not an enforceable allow-list)',
    category: 'autopilot-lease',
    fixture: 'lease-derived',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/unleased.ts'),
    }),
    expected: { exitCode: 0 },
  },
  {
    name: 'fully terminal graph fails open even with a leftover lease',
    category: 'autopilot-lease',
    fixture: 'lease-terminal',
    raw: (ctx) => ({
      session_id: ctx.sessionId,
      ...fileTool('Write', 'src/unleased.ts'),
    }),
    expected: { exitCode: 0 },
  },

  // ── JVM internal-packages guard ────────────────────────────────────────────
  {
    name: 'JVM CodeQL run with an undeclared sibling JAR blocks',
    category: 'internal-packages',
    fixture: 'jvm-jar',
    raw: bash('ditto impact --language java'),
    expected: { exitCode: 2, stderrIncludes: 'internal-packages' },
  },
  {
    name: 'JVM CodeQL run with the JAR declared allows (adjacent)',
    category: 'internal-packages',
    fixture: 'jvm-jar-declared',
    raw: bash('ditto impact --language java'),
    expected: { exitCode: 0 },
  },
  {
    name: 'non-JVM language never triggers the guard (adjacent)',
    category: 'internal-packages',
    fixture: 'jvm-jar',
    raw: bash('ditto impact --language javascript'),
    expected: { exitCode: 0 },
  },

  // ── Codex envelope decisions ───────────────────────────────────────────────
  {
    name: 'shell-run apply_patch outside the tool gate blocks (codex)',
    category: 'codex-envelope',
    fixture: 'bare',
    host: 'codex',
    raw: {
      tool_name: 'exec_command',
      tool_input: { cmd: 'apply_patch << EOF\n*** Begin Patch\n*** End Patch\nEOF' },
    },
    expected: { exitCode: 2, stderrIncludes: 'apply-patch-bypass' },
  },
  {
    name: 'codex apply_patch touching a secret path blocks',
    category: 'codex-envelope',
    fixture: 'bare',
    host: 'codex',
    raw: {
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: .env\n@@\n+X=1\n*** End Patch',
      },
    },
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'codex write_stdin carrying apply_patch content with a secret blocks',
    category: 'codex-envelope',
    fixture: 'bare',
    host: 'codex',
    raw: {
      tool_name: 'write_stdin',
      tool_input: {
        chars: '*** Begin Patch\n*** Update File: .env\n@@\n+X=1\n*** End Patch',
      },
    },
    expected: { exitCode: 2, stderrIncludes: 'secret' },
  },
  {
    name: 'codex apply_patch touching an in-repo source file allows (adjacent)',
    category: 'codex-envelope',
    fixture: 'bare',
    host: 'codex',
    raw: {
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: src/inside.ts\n@@\n+// ok\n*** End Patch',
      },
    },
    expected: { exitCode: 0 },
  },

  // ── default allow ──────────────────────────────────────────────────────────
  {
    name: 'unmatched tool allows (default is ALLOW)',
    category: 'default-allow',
    fixture: 'bare',
    raw: { tool_name: 'WebSearch', tool_input: { query: 'ditto hooks' } },
    expected: { exitCode: 0 },
  },
  {
    name: 'Bash without a command string allows',
    category: 'default-allow',
    fixture: 'bare',
    raw: { tool_name: 'Bash', tool_input: {} },
    expected: { exitCode: 0 },
  },
];
