import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseJvmCodeqlCommand, runInternalPackagesGuard } from '~/acg/internal-packages';
import { matchForbiddenScope, scopeRefMatches } from '~/acg/scope/resolve';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { AutopilotStore } from '~/core/autopilot-store';
import { ChangeContractStore } from '~/core/change-contract-store';
import { atomicWriteText, ensureDir, readArchitectureSpec } from '~/core/fs';
import { SessionPointerStore } from '~/core/session-pointer';
import { type AcgArchitectureSpec, acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import type { HookHandler, HookInput } from './runtime';

/**
 * PreToolUse safety hook (M3.2). Blocks a conservative set of clearly
 * destructive / scope-violating / secret-touching tool calls (exit 2) and
 * allows everything else (exit 0). The fail-open guarantees (DITTO_SKIP_HOOKS,
 * handler crash) live in the `runHook` wrapper — this body does NOT re-check the
 * kill-switch and does NOT self-wrap in try/catch (a throw must fail open).
 *
 * Default is ALLOW: an unmatched tool, or a missing/non-string field, never
 * blocks. We only block when a pattern matches with confidence.
 */

// Windows has no $HOME; it exposes the home directory as %USERPROFILE%. Fall back
// so the rm-outside-home exemption keys on the real home dir on every platform.
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '';
const IS_WIN = process.platform === 'win32';

function block(category: string, reason: string) {
  return {
    exitCode: 2,
    stderr: `DITTO PreToolUse: blocked ${category} — ${reason}. Set DITTO_SKIP_HOOKS=1 to bypass.\n`,
  };
}
const ALLOW = { exitCode: 0 } as const;

// --- (b) secret files -------------------------------------------------------
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.ssh\//,
  /(^|\/)credentials?($|[._-])/,
];
/** Template/example suffixes: a `*.env.example` etc. holds no real secret. */
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.tmpl'];
function isTemplatePath(p: string): boolean {
  return TEMPLATE_SUFFIXES.some((s) => p.endsWith(s));
}
function isSecretPath(p: string): boolean {
  // Template/example files are excluded here so every consumer (file-tool path,
  // Bash operand scan) treats `.env.example` / `credentials.sample` as harmless.
  if (isTemplatePath(p)) return false;
  return SECRET_PATTERNS.some((re) => re.test(p));
}

// --- (b) Bash secret exposure: default-deny ---------------------------------
// Invariant: a secret file's CONTENTS must not be able to leave via this
// command; block any secret path used as a readable file operand or stdin
// source, allowing only name-only metadata verbs, template-suffixed example
// files, and grep/rg search-pattern positions.
//
// This is DEFAULT-DENY: an UNKNOWN verb with a bare secret file operand BLOCKS
// (e.g. `sort .env`, `jq . .env`, `dd if=id_rsa`). The previous expose-verb
// allowlist was under-inclusive and let ~30 real exfil commands through.

/** Verbs that only list/stat a name without reading its contents → allowed. */
const METADATA_VERBS: ReadonlySet<string> = new Set([
  'ls',
  'find',
  'stat',
  'file',
  'basename',
  'dirname',
  'realpath',
  'test',
  '[',
  'which',
  'type',
]);
/** Verbs whose first non-flag operand is a SEARCH PATTERN, not a file. */
const SEARCH_VERBS: ReadonlySet<string> = new Set(['grep', 'rg', 'egrep', 'fgrep']);
/** Flags after which the next token is a pattern/file source, not the pattern. */
const SEARCH_PATTERN_FLAGS: ReadonlySet<string> = new Set(['-e', '--regexp', '-f', '--file']);

/** Split a command into pipeline / sequence segments. */
function commandSegments(cmd: string): string[] {
  return cmd.split(/\|\||&&|[;&|]/).map((s) => s.trim());
}

/**
 * The operative command word of a segment: the first token after any leading
 * `VAR=value` environment assignments. Lets a destructive-primitive check key on
 * what the segment actually RUNS (`sudo …`) rather than a token that merely
 * appears inside a quoted argument (e.g. `git commit -m "… sudo rm …"`). Pure
 * string work — OS-independent (works under cmd/PowerShell/bash alike).
 */
function leadingCommand(seg: string): string {
  const afterEnv = seg.replace(/^(?:\s*[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*\s*/, '');
  return afterEnv.split(/\s+/)[0] ?? '';
}

/**
 * Tokens of a segment. Splits on whitespace / quotes / `=` (so `if=id_rsa` and
 * `-d=...` decompose, exposing the secret operand) and isolates a leading
 * redirect operator (`<`, `0<`) as its own `<` marker token so the stdin source
 * that follows can be detected. A glued `<.env` becomes `<` then `.env`.
 */
function segmentTokens(seg: string): string[] {
  const out: string[] = [];
  for (const raw of seg.split(/[\s'"=]+/)) {
    if (raw.length === 0) continue;
    const redir = raw.match(/^([0-9]*<)(.*)$/);
    if (redir) {
      out.push('<');
      if (redir[2] && redir[2].length > 0) out.push(redir[2]);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Strip operand decorations: leading `@` (curl body file) for the path test. */
function asPath(t: string): string {
  return t.startsWith('@') ? t.slice(1) : t;
}

/**
 * Default-deny secret scan. Returns the offending secret token (for the block
 * message), or undefined when no segment leaks a secret.
 */
function bashSecretExposure(cmd: string): string | undefined {
  for (const seg of commandSegments(cmd)) {
    const tokens = segmentTokens(seg);
    if (tokens.length === 0) continue;
    const verb = tokens[0] ?? '';
    const args = tokens.slice(1);

    // 1. stdin redirection: `… < .env` exfiltrates a secret's contents.
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '<') {
        const src = args[i + 1] ?? '';
        if (isSecretPath(asPath(src))) return asPath(src);
      }
    }

    // grep/rg: the first non-flag operand is the search PATTERN (allowed even if
    // secret-shaped); any later non-flag operand is a FILE operand and blocks.
    if (SEARCH_VERBS.has(verb)) {
      let seenPattern = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? '';
        if (a === '<') {
          i++; // redirect already handled above
          continue;
        }
        if (a.startsWith('-')) {
          if (SEARCH_PATTERN_FLAGS.has(a)) i++; // its argument is not a file
          continue;
        }
        if (!seenPattern) {
          seenPattern = true; // this operand is the search pattern, not a file
          continue;
        }
        if (isSecretPath(asPath(a))) return asPath(a);
      }
      continue;
    }

    // 2. default-deny: any secret token used as a file operand blocks, with
    //    only metadata-verb and template-suffix exceptions.
    const secretToken = args.find(
      (t) => t !== '<' && !t.startsWith('-') && isSecretPath(asPath(t)),
    );
    if (secretToken === undefined) continue;
    // (b) metadata-only verbs list/stat the name without reading contents.
    if (METADATA_VERBS.has(verb)) continue;
    // (a) template suffixes are already excluded inside isSecretPath.
    return asPath(secretToken);
  }
  return undefined;
}

// --- (c) scope-out write ----------------------------------------------------
/** True when `filePath` resolves outside `repoRoot`. */
function isOutsideRepo(repoRoot: string, filePath: string): boolean {
  const resolved = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, resolved);
  return rel.startsWith('..') || isAbsolute(rel);
}

/**
 * NARROW scope-out exception: the CURRENT project's Claude Code auto-memory
 * directory, `<home>/.claude/projects/<slug(repoRoot)>/memory/…`. Writing here
 * keeps an agent's cross-session continuity intact, so the scope-out guard must
 * let it through — but ONLY this one subtree. Narrowed to the current project
 * (round-2 review R4): a cross-project allowance would let a prompt-injected
 * agent poison another project's MEMORY.md, which Claude Code auto-loads into
 * every future session there (persistent cross-session injection). Any other
 * `~/.claude/…` path stays a scope-out block, and secret-shaped names are still
 * caught upstream by `isSecretPath`.
 */
function isClaudeMemoryPath(repoRoot: string, filePath: string): boolean {
  const home = process.env.HOME ?? homedir();
  if (!home) return false;
  // Claude Code names the project dir by replacing every non-alphanumeric char
  // of the absolute project path with '-'.
  const slug = resolve(repoRoot).replace(/[^a-zA-Z0-9]/g, '-');
  const base = resolve(home, '.claude', 'projects', slug, 'memory');
  const rel = relative(base, resolve(filePath));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

// --- (a) destructive Bash ---------------------------------------------------
/** Literal whole-filesystem / home wipes that must always block. */
const RM_LITERAL_BLOCK = ['rm -rf /', 'rm -rf ~', 'rm -rf /*', 'rm -rf ~/'];

function isRecursiveForceRm(cmd: string): boolean {
  // `rm` with both recursive and force flags (in any order / combined form).
  if (!/(^|[;&|]\s*)rm\b/.test(cmd)) return false;
  const hasRecursive = /\s-\w*r/i.test(cmd) || /--recursive\b/.test(cmd);
  const hasForce = /\s-\w*f/i.test(cmd) || /--force\b/.test(cmd);
  return hasRecursive && hasForce;
}

/** Extract bare-ish path arguments of an `rm` (best effort; skips flags). */
function rmTargets(cmd: string): string[] {
  const m = cmd.match(/\brm\b([^;&|]*)/);
  if (!m) return [];
  return (m[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

// A catastrophic Windows location: a bare drive root (`c:`, `c:\`, `c:\*`), a UNC
// root (`\\`), or a system/home environment variable — NOT a specific subpath
// (`c:\users\me\app`), so wiping a whole drive/system is caught while a scoped
// delete is left alone (footgun line, mirrors the POSIX root/home logic).
const WIN_ROOT =
  /(^|\s)[a-z]:\\?\*?(\s|$)|\\\\|%systemdrive%|%systemroot%|%userprofile%|%homepath%|%homedrive%|%windir%|%programfiles%/i;
// Removal commands across cmd.exe and PowerShell (incl. PowerShell aliases for
// Remove-Item: ri, rm, rd, del, rmdir, erase).
const WIN_REMOVE_CMDS: ReadonlySet<string> = new Set([
  'rd',
  'rmdir',
  'del',
  'erase',
  'remove-item',
  'ri',
  'rm',
]);

/** A Windows-absolute path: drive-qualified (`c:\`, `c:/`), UNC (`\\`), or
 * drive-root-relative (`\foo`). Pure regex — independent of the runtime's
 * `node:path` flavor, so it judges Windows paths correctly even on POSIX. */
function isWinAbsolute(p: string): boolean {
  return /^([a-z]:[\\/]|\\\\|[\\/])/i.test(p);
}
/** Normalize a Windows path for case-insensitive containment: `/`→`\`, drop a
 * trailing separator, lowercase. */
function winNorm(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
/** True when `child` is `parent` or sits under it (Windows is case-insensitive). */
function winInside(child: string, parent: string): boolean {
  if (!parent) return false;
  const c = winNorm(child);
  const par = winNorm(parent);
  return c === par || c.startsWith(`${par}\\`);
}
/** Candidate path operands of a delete segment: tokens that are neither flags
 * (`/s`, `-Recurse`) nor the command word, de-quoted. */
function winDeleteTargets(seg: string): string[] {
  return seg
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(
      (t) =>
        t.length > 0 &&
        !t.startsWith('/') &&
        !t.startsWith('-') &&
        t.toLowerCase() !== 'format' &&
        !WIN_REMOVE_CMDS.has(t.toLowerCase()),
    );
}

/**
 * Reason a Windows command is a destructive footgun, or null. Pure + OS-agnostic
 * (callers gate it on `IS_WIN`). Conservative, mirrors the POSIX rm policy:
 * requires the segment's OPERATIVE command to be a removal/format command AND
 * a recursive intent (`/s`, or `-Recurse -Force`), then flags either a whole
 * drive root / system location, OR — like `rm -rf` outside home — an absolute
 * path that is not inside `home`. A scoped relative path (assumed in-repo), a
 * glob/env-var target (unresolvable, skipped), or a quoted mention never match.
 */
export function windowsDestructiveReason(normalized: string, home = ''): string | null {
  for (const seg of commandSegments(normalized)) {
    const cmd = leadingCommand(seg).toLowerCase();
    // `format <drive>:` wipes an entire volume.
    if (cmd === 'format' && /(^|\s)[a-z]:/i.test(seg)) {
      return 'format of a Windows drive';
    }
    if (!WIN_REMOVE_CMDS.has(cmd)) continue;
    const recursive =
      /(^|\s)\/s\b/i.test(seg) || (/-recurse\b/i.test(seg) && /-force\b/i.test(seg));
    if (!recursive) continue;
    // Drive root / system location: `rd /s /q c:\`, `Remove-Item -Recurse -Force c:\`.
    if (WIN_ROOT.test(seg)) {
      return 'recursive delete of a Windows drive root or system location';
    }
    // Arbitrary absolute path outside home (relative targets are assumed in-repo
    // and allowed; `*`/`%env%` targets are unresolvable and skipped — same
    // conservative stance as the POSIX rm target check).
    const outside = winDeleteTargets(seg).find(
      (t) => isWinAbsolute(t) && !/[*%]/.test(t) && !winInside(t, home),
    );
    if (outside) {
      return 'recursive delete of an absolute Windows path outside home';
    }
  }
  return null;
}

function checkDestructive(cmd: string) {
  const normalized = cmd.replace(/\s+/g, ' ').trim();

  // Windows destructive primitives (only meaningful on Windows; gated so a word
  // like `format` in a POSIX shell can't false-positive).
  if (IS_WIN) {
    const winReason = windowsDestructiveReason(normalized, HOME);
    if (winReason) return block('destructive', winReason);
  }

  // fork bomb
  if (normalized.replace(/\s/g, '').includes(':(){:|:&};:')) {
    return block('destructive', 'fork bomb');
  }
  // disk-destroying primitives
  if (/\bmkfs\.?\w*/.test(normalized)) return block('destructive', 'mkfs on a device');
  if (/\bdd\b[^;&|]*\bof=\/dev\//.test(normalized)) return block('destructive', 'dd to a device');
  if (/>\s*\/dev\/sd/.test(normalized)) return block('destructive', 'overwrite of a block device');

  // sudo + dangerous primitive. Confine to segments whose operative command is
  // actually `sudo`, so a destructive word merely quoted in another command's
  // argument (e.g. `git commit -m "… sudo rm …"`) can't synthesize a false
  // positive — the same narrowing applied to force-push detection.
  if (
    commandSegments(normalized)
      .filter((seg) => leadingCommand(seg) === 'sudo')
      .some((seg) => /\b(rm|dd|mkfs\.?\w*)\b/.test(seg))
  ) {
    return block('destructive', 'sudo with a destructive command');
  }

  // force-push to a default branch. Confine all three signals (git push, a
  // force flag, a default-branch name) to the SAME command segment, so an
  // unrelated flag/branch token elsewhere in a compound command cannot
  // synthesize a false positive — e.g. `rm -rf x && git push origin main`,
  // where `rm -rf` supplies the `-…f` the whole-string test mistook for `-f`.
  const pushSegments = normalized
    .split(/[;&|]+/)
    .map((seg) => seg.trim())
    .filter((seg) => /\bgit\b.*\bpush\b/.test(seg));
  if (
    pushSegments.some(
      (seg) =>
        /(--force-with-lease|--force|(^|\s)-\w*f)/.test(seg) && /\b(main|master)\b/.test(seg),
    )
  ) {
    return block('destructive', 'force-push to a default branch');
  }

  // rm -rf wipes
  if (RM_LITERAL_BLOCK.includes(normalized)) {
    return block('destructive', 'recursive force remove of a root/home path');
  }
  if (isRecursiveForceRm(normalized)) {
    for (const target of rmTargets(normalized)) {
      // Only static (no shell-expansion) targets are judged; a target outside
      // both the repo and $HOME is treated as a wipe of unrelated files.
      if (/[$`*]/.test(target)) continue;
      // Only absolute targets are judged confidently; a relative target is
      // assumed inside the repo cwd (the conservative ALLOW default).
      if (!isAbsolute(target)) continue;
      const insideHome = HOME.length > 0 && (target === HOME || target.startsWith(`${HOME}/`));
      if (!insideHome) {
        return block('destructive', `recursive force remove outside repo/home (${target})`);
      }
    }
  }

  return ALLOW;
}

// --- (d) ChangeContract forbidden_scope enforcement -------------------------
// 현재 work item의 계약을 읽어, 편집 대상 파일이 forbidden_scope의 해소 집합에 들면 막는다.
// 모든 전제 부재(세션 없음·계약 없음·빈 forbidden)는 undefined를 돌려 ALLOW로 떨어진다.

/** `.ditto/architecture-spec.json`을 optional 로드(부재·위반 시 undefined → layer/surface skip). */
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

/** 편집 대상 file_path가 현재 work item 계약의 forbidden_scope에 들면 block, 아니면 undefined. */
async function checkForbiddenScope(
  input: HookInput,
  filePath: string,
): Promise<ReturnType<typeof block> | undefined> {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return undefined;

  const workItemId = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!workItemId) return undefined;

  const contract = await new ChangeContractStore(input.repoRoot).read(workItemId);
  if (!contract || contract.forbidden_scope.length === 0) return undefined;

  const repoRel = relative(input.repoRoot, resolve(input.repoRoot, filePath));
  const archSpec = await loadArchSpec(input.repoRoot);
  const hit = matchForbiddenScope(contract.forbidden_scope, repoRel, archSpec);
  if (hit) {
    return block(
      'forbidden-scope',
      `${repoRel} is in this work item's forbidden_scope (${hit.kind}:${hit.ref})`,
    );
  }
  return undefined;
}

// --- autopilot 경로 강제: active-node lease allow-list ----------------------
// FLOW enforcement (wi_26060678y): while an autopilot node is in flight it holds
// an active-node lease (node_id + file_scope). A file edit is ALLOWED only when
// its path falls inside SOME active lease's file_scope (an allow-list). This is
// not spawn proof (PreToolUse cannot observe spawn, SKILL.md:33) — the lease is
// the observable in-flight signal. There is NO repo-name / self-host branch: a
// DITTO-repo edit out of lease hits the same block as any other repo (ac-5).

/** Explicit bypass affordance, DISTINCT from DITTO_SKIP_HOOKS (ac-3). */
function autopilotBypassActive(input: HookInput): boolean {
  const env = input.env ?? {};
  return env.DITTO_AUTOPILOT_BYPASS === '1' || process.env.DITTO_AUTOPILOT_BYPASS === '1';
}

/** Append exactly one bypass record per bypassed out-of-scope edit (ac-3). */
async function appendBypassRecord(repoRoot: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(repoRoot, '.ditto');
  await ensureDir(dir);
  const path = join(dir, 'autopilot-bypass.jsonl');
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(entry)}\n`);
}

/** A lease file_scope string → AcgScopeRef so the EXISTING matcher decides containment. */
function fileScopeContains(scope: string[], repoRelPath: string): boolean {
  return scope.some((s) =>
    scopeRefMatches(
      /[*?[\]]/.test(s) ? { kind: 'glob', ref: s } : { kind: 'path', ref: s },
      repoRelPath,
    ),
  );
}

/**
 * Allow-list lease check. Returns a block when the edit is OUTSIDE every active
 * lease's file_scope under an autopilot graph; undefined (ALLOW) otherwise. All
 * preconditions fail OPEN (no session / no active WI / no graph / no non-terminal
 * node / no active lease) — a lease only exists while a node runs, so a graph with
 * no active lease means nothing is dispatched and we must not false-block.
 */
async function checkAutopilotLease(
  input: HookInput,
  filePath: string,
): Promise<ReturnType<typeof block> | undefined> {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return undefined; // fail-open: untracked session

  const workItemId = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!workItemId) return undefined; // fail-open: no active work item

  const aps = new AutopilotStore(input.repoRoot);
  if (!(await aps.exists(workItemId))) return undefined; // fail-open: not under autopilot
  let hasNonTerminal: boolean;
  try {
    const graph = await aps.get(workItemId);
    hasNonTerminal = graph.nodes.some(
      (n) => n.status === 'pending' || n.status === 'running' || n.status === 'blocked',
    );
  } catch {
    return undefined; // fail-open: unreadable graph
  }
  if (!hasNonTerminal) return undefined; // fail-open: graph fully terminal

  const leases = await new ActiveNodeLeaseStore(input.repoRoot).listActive(workItemId);
  if (leases.length === 0) return undefined; // fail-open: nothing dispatched (no in-flight node)

  const repoRel = relative(input.repoRoot, resolve(input.repoRoot, filePath));
  const inScope = leases.some((l) => fileScopeContains(l.file_scope, repoRel));
  if (inScope) return undefined; // allow-list hit

  // Out of every active lease scope. Bypass (ac-3) overrides the block and logs.
  if (autopilotBypassActive(input)) {
    await appendBypassRecord(input.repoRoot, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      work_item_id: workItemId,
      file_path: repoRel,
      active_leases: leases.map((l) => l.node_id),
    });
    return undefined;
  }
  return block(
    'autopilot-path',
    `${repoRel} is outside every active autopilot node's file_scope (${leases
      .map((l) => l.node_id)
      .join(', ')}); edit inside the dispatched node's scope or set DITTO_AUTOPILOT_BYPASS=1`,
  );
}

export const preToolUseHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const toolName = raw.tool_name;
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  const repoRoot = input.repoRoot;

  // --- Bash ---------------------------------------------------------------
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
    if (!command) return ALLOW;

    const destructive = checkDestructive(command);
    if (destructive.exitCode === 2) return destructive;

    // (b) secret-file exposure inside a Bash command — verb-aware (a secret-shaped
    // name under a non-exposing verb like `git log` / `ls` / `grep -r … src/` is
    // not a leak and must not block).
    const exposed = bashSecretExposure(command);
    if (exposed !== undefined) {
      return block('secret', `command exposes a secret file (${exposed})`);
    }

    // (c) best-effort static redirect / copy destination. The Claude session
    // auto-memory dir is a narrow exception (secret operands already blocked
    // above by bashSecretExposure, which keeps secret-priority intact).
    for (const dest of bashWriteTargets(command)) {
      if (isOutsideRepo(repoRoot, dest) && !isClaudeMemoryPath(repoRoot, dest)) {
        return block('scope-out', `write outside repo (${dest})`);
      }
    }

    // (e) JVM CodeQL cross_repo guard — a `ditto impact|boundary --language java|kotlin`
    // run on a single-module DB silently drops sibling-module (JAR) impact unless
    // internal_packages is declared. Block (only) when local JARs exist with a
    // declaration gap, so the agent declares it before the expensive CodeQL build.
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
        return block('internal-packages', guard.reason);
      }
    }

    return ALLOW;
  }

  // --- File tools ---------------------------------------------------------
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  if (!filePath) return ALLOW;

  // (b) secret file — read AND write both block
  if (isSecretPath(filePath)) {
    return block('secret', `access to a secret file (${filePath})`);
  }

  // (c) scope-out write. The Claude session auto-memory dir is a narrow
  // exception so agent continuity survives; secret already blocked above, so
  // priority stays secret > claude-memory allow > scope-out block.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    if (isOutsideRepo(repoRoot, filePath) && !isClaudeMemoryPath(repoRoot, filePath)) {
      return block('scope-out', `write outside repo (${filePath})`);
    }
    // (d) forbidden_scope: 계약이 보호하는 파일을 건드리면 막는다.
    const forbidden = await checkForbiddenScope(input, filePath);
    if (forbidden) return forbidden;
    // (f) autopilot 경로 강제: 진행 중 노드의 lease file_scope 밖 편집을 막는다(allow-list).
    const offPath = await checkAutopilotLease(input, filePath);
    if (offPath) return offPath;
  }

  return ALLOW;
};

/** Statically extractable write destinations from a Bash command (else none). */
function bashWriteTargets(cmd: string): string[] {
  // Quoted spans are opaque WORDS, not shell syntax (wi_260610767): a `>`
  // inside quotes is prose (live FP — commit messages were blocked), while a
  // quoted token right after a redirect IS the target (it previously slipped
  // the scope check because the quote char rode into the resolved path).
  // Replace each span with a placeholder, scan the skeleton, then map any
  // placeholder in an extracted target back to its quoted content.
  // Placeholder delimiter = SOH (U+0001): a control char that cannot appear
  // in a typed command, so an index wrapped in it never collides with text.
  const P = String.fromCharCode(1);
  const spans: string[] = [];
  const skeleton = cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => {
    spans.push(q.slice(1, -1));
    return `${P}${spans.length - 1}${P}`;
  });
  const placeholderRe = new RegExp(`${P}(\\d+)${P}`, 'g');
  const unquote = (t: string): string =>
    t.replace(placeholderRe, (_, i: string) => spans[Number(i)] ?? '');
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const t = unquote(raw);
    // unresolvable-at-parse-time targets (vars, substitution, globs) stay skipped
    if (t.length === 0 || /[$`*]/.test(t)) return;
    out.push(t);
  };
  // redirections: `> path` / `>> path`
  for (const m of skeleton.matchAll(/>>?\s*([^\s;&|>]+)/g)) {
    const t = m[1];
    if (t && !unquote(t).startsWith('/dev/')) push(t);
  }
  // `tee path`
  for (const m of skeleton.matchAll(/\btee\b\s+(?:-\S+\s+)*([^\s;&|]+)/g)) {
    push(m[1]);
  }
  // `cp src dest` / `mv src dest` — last token is the destination
  for (const m of skeleton.matchAll(/\b(?:cp|mv)\b([^;&|]*)/g)) {
    const args = (m[1] ?? '')
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0 && !a.startsWith('-'));
    if (args.length >= 2) push(args[args.length - 1]);
  }
  return out;
}
