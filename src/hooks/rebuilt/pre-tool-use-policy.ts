import { isAbsolute, relative, resolve } from 'node:path';
import { matchForbiddenScope, scopeRefMatches } from '~/acg/scope/resolve';
import type { ActiveNodeLease } from '~/core/active-node-lease';
import { isMutatingOwner } from '~/core/autopilot-dispatch';
import { kindToOwner } from '~/core/autopilot-graph';
import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import type { AcgChangeContract } from '~/schemas/acg-change-contract';
import type { Autopilot } from '~/schemas/autopilot';
// Subtle, test-pinned pure policies are IMPORTED from the dormant legacy module
// rather than re-derived: re-deriving them would risk silent decision drift on
// exactly the carve-outs their comments document (Windows path semantics,
// tmp-root allowances, worktree-relative scope comparison).
import { isSystemTmpPath, leaseScopeRelPath, windowsDestructiveReason } from '../pre-tool-use';

export { isSystemTmpPath, leaseScopeRelPath, windowsDestructiveReason };

/**
 * PreToolUse PURE decision policy (rebuild increment 3). Every observable
 * blocking decision of the PreToolUse gate lives here as a pure function over
 * strings/paths/loaded state — no stores, no env, no process access. The thin
 * shell (`./pre-tool-use.ts`) owns envelope parsing and state loading.
 *
 * Default is ALLOW: an unmatched shape never blocks; we block only when a
 * pattern matches with confidence. Decision parity with the legacy handler is
 * pinned by the shared table in `src/hooks/parity-cases.ts`.
 */

export type PreToolDecision =
  | { verdict: 'allow' }
  | { verdict: 'block'; category: string; reason: string };

export const ALLOW: PreToolDecision = { verdict: 'allow' };

export function blockDecision(category: string, reason: string): PreToolDecision {
  return { verdict: 'block', category, reason };
}

// ── secret files ────────────────────────────────────────────────────────────
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

export function isSecretPath(p: string): boolean {
  if (TEMPLATE_SUFFIXES.some((s) => p.endsWith(s))) return false;
  return SECRET_PATTERNS.some((re) => re.test(p));
}

// ── shell-command lexing ────────────────────────────────────────────────────
/** Split a command into pipeline / sequence segments. */
function commandSegments(cmd: string): string[] {
  return cmd.split(/\|\||&&|[;&|]/).map((s) => s.trim());
}

/** First token after any leading `VAR=value` env assignments — what a segment RUNS. */
function leadingCommand(seg: string): string {
  const afterEnv = seg.replace(/^(?:\s*[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*\s*/, '');
  return afterEnv.split(/\s+/)[0] ?? '';
}

function shellWords(seg: string): string[] {
  return seg.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
}

function isShellEnvAssignment(word: string): boolean {
  return /^[A-Za-z_]\w*=/.test(word);
}

function basenameCommand(word: string): string {
  return word.replace(/^.*[\\/]/, '');
}

/**
 * The command a segment ultimately executes, skipping `env`/`command`/`exec`/
 * `sudo` wrappers and env assignments. Quoted spans stay whole words, so a
 * command name mentioned inside a quoted argument never reads as operative.
 */
function operativeShellCommand(seg: string): string {
  const words = shellWords(seg);
  let i = 0;

  while (i < words.length) {
    while (i < words.length && isShellEnvAssignment(words[i] ?? '')) i++;

    const word = words[i] ?? '';
    if (word === 'env') {
      i++;
      while (i < words.length) {
        const current = words[i] ?? '';
        if (current === '-u' || current === '--unset') {
          i += 2;
          continue;
        }
        if (current === '-i' || current === '--ignore-environment' || current.startsWith('-u')) {
          i++;
          continue;
        }
        if (current.startsWith('-')) {
          i++;
          continue;
        }
        if (isShellEnvAssignment(current)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    if (word === 'command' || word === 'exec' || word === 'sudo') {
      i++;
      while (word === 'sudo' && i < words.length && (words[i] ?? '').startsWith('-')) i++;
      continue;
    }

    return basenameCommand(word);
  }

  return '';
}

export function shellRunsApplyPatch(cmd: string): boolean {
  return commandSegments(cmd).some((seg) => operativeShellCommand(seg) === 'apply_patch');
}

// ── Bash secret exposure: default-deny ──────────────────────────────────────
// Invariant: a secret file's CONTENTS must not leave via this command. Block any
// secret path used as a readable file operand or stdin source; allow only
// name-only metadata verbs, template-suffixed example files, and grep/rg
// search-pattern positions. DEFAULT-DENY: an UNKNOWN verb with a bare secret
// file operand blocks (`sort .env`, `jq . .env`, `dd if=id_rsa`).

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

/**
 * Tokens of a segment. Splits on whitespace / quotes / `=` (so `if=id_rsa`
 * decomposes, exposing the secret operand) and isolates a leading redirect
 * operator (`<`, `0<`) as its own `<` marker token; a glued `<.env` becomes `<`
 * then `.env`.
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
export function bashSecretExposure(cmd: string): string | undefined {
  for (const seg of commandSegments(cmd)) {
    const tokens = segmentTokens(seg);
    if (tokens.length === 0) continue;
    const verb = tokens[0] ?? '';
    const args = tokens.slice(1);

    // stdin redirection: `… < .env` exfiltrates a secret's contents.
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

    // default-deny: any secret token used as a file operand blocks, with only
    // metadata-verb and template-suffix exceptions.
    const secretToken = args.find(
      (t) => t !== '<' && !t.startsWith('-') && isSecretPath(asPath(t)),
    );
    if (secretToken === undefined) continue;
    if (METADATA_VERBS.has(verb)) continue;
    return asPath(secretToken);
  }
  return undefined;
}

// ── destructive Bash primitives + no-verify push ────────────────────────────
/** Literal whole-filesystem / home wipes that must always block. */
const RM_LITERAL_BLOCK = ['rm -rf /', 'rm -rf ~', 'rm -rf /*', 'rm -rf ~/'];

function isRecursiveForceRm(cmd: string): boolean {
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

export interface CommandPolicyEnv {
  /** The runtime home directory ('' when unknown). */
  home: string;
  /** Runtime platform gate for the Windows destructive-primitive mirror. */
  isWindows: boolean;
}

/**
 * Destructive-primitive + no-verify-push policy over one Bash/exec command.
 * Order and semantics mirror the pinned legacy decisions: Windows mirror (gated
 * on the runtime platform), fork bomb, disk primitives, sudo-destructive,
 * force-push to a default branch, `git push --no-verify`, and rm -rf wipes.
 */
export function destructiveCommandDecision(cmd: string, env: CommandPolicyEnv): PreToolDecision {
  const normalized = cmd.replace(/\s+/g, ' ').trim();

  if (env.isWindows) {
    const winReason = windowsDestructiveReason(normalized, env.home);
    if (winReason) return blockDecision('destructive', winReason);
  }

  if (normalized.replace(/\s/g, '').includes(':(){:|:&};:')) {
    return blockDecision('destructive', 'fork bomb');
  }
  if (/\bmkfs\.?\w*/.test(normalized)) return blockDecision('destructive', 'mkfs on a device');
  if (/\bdd\b[^;&|]*\bof=\/dev\//.test(normalized)) {
    return blockDecision('destructive', 'dd to a device');
  }
  if (/>\s*\/dev\/sd/.test(normalized)) {
    return blockDecision('destructive', 'overwrite of a block device');
  }

  // sudo + dangerous primitive — only when the segment's operative command IS
  // sudo, so a destructive word quoted in another command's argument stays inert.
  if (
    commandSegments(normalized)
      .filter((seg) => leadingCommand(seg) === 'sudo')
      .some((seg) => /\b(rm|dd|mkfs\.?\w*)\b/.test(seg))
  ) {
    return blockDecision('destructive', 'sudo with a destructive command');
  }

  // force-push to a default branch — all three signals confined to ONE segment.
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
    return blockDecision('destructive', 'force-push to a default branch');
  }

  // `git push --no-verify` skips the pre-push test gate. Keyed on the segment's
  // OPERATIVE command being git with push + --no-verify as real words, so an
  // echoed/commit-message mention stays inert.
  for (const seg of commandSegments(normalized)) {
    if (operativeShellCommand(seg) !== 'git') continue;
    const words = shellWords(seg);
    if (words.includes('push') && words.includes('--no-verify')) {
      return blockDecision('no-verify-push', 'git push --no-verify skips the pre-push test gate');
    }
  }

  // rm -rf wipes
  if (RM_LITERAL_BLOCK.includes(normalized)) {
    return blockDecision('destructive', 'recursive force remove of a root/home path');
  }
  if (isRecursiveForceRm(normalized)) {
    for (const target of rmTargets(normalized)) {
      // Only static (no shell-expansion) absolute targets are judged; a relative
      // target is assumed inside the repo cwd (conservative ALLOW default).
      if (/[$`*]/.test(target)) continue;
      if (!isAbsolute(target)) continue;
      const insideHome =
        env.home.length > 0 && (target === env.home || target.startsWith(`${env.home}/`));
      if (!insideHome) {
        return blockDecision('destructive', `recursive force remove outside repo/home (${target})`);
      }
    }
  }

  return ALLOW;
}

// ── path containment ────────────────────────────────────────────────────────
/** True when `filePath` resolves outside `repoRoot`. */
export function isOutsideRepo(repoRoot: string, filePath: string): boolean {
  const resolved = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, resolved);
  return rel.startsWith('..') || isAbsolute(rel);
}

/**
 * NARROW scope-out exception: the CURRENT project's Claude Code auto-memory
 * directory, `<home>/.claude/projects/<slug(repoRoot)>/memory/…`, so an agent's
 * cross-session continuity survives — and ONLY this subtree. A cross-project
 * allowance would let a prompt-injected agent poison another project's
 * MEMORY.md (persistent cross-session injection), so any other `~/.claude/…`
 * path stays a scope-out block.
 */
export function isClaudeMemoryPath(repoRoot: string, filePath: string, home: string): boolean {
  if (!home) return false;
  // Claude Code names the project dir by replacing every non-alphanumeric char
  // of the absolute project path with '-'.
  const slug = resolve(repoRoot).replace(/[^a-zA-Z0-9]/g, '-');
  const base = resolve(home, '.claude', 'projects', slug, 'memory');
  const rel = relative(base, resolve(filePath));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

// ── Bash write-destination extraction ───────────────────────────────────────
/** Statically extractable write destinations from a Bash command (else none). */
export function bashWriteTargets(cmd: string): string[] {
  // Quoted spans are opaque WORDS, not shell syntax: a `>` inside quotes is
  // prose, while a quoted token right after a redirect IS the target. Replace
  // each span with a placeholder, scan the skeleton, then map any placeholder in
  // an extracted target back to its quoted content. Placeholder delimiter = SOH
  // (U+0001): a control char that cannot appear in a typed command.
  const P = String.fromCharCode(1);
  const spans: string[] = [];
  // Heredoc BODIES are DATA, not shell syntax: a `>` inside a heredoc-fed commit
  // message is prose. Drop the body (keep the OPENER line, which can carry a
  // real redirect) before the scan.
  const deheredoc = cmd.replace(
    /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3(?=\s|$)/g,
    '$1',
  );
  const skeleton = deheredoc.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => {
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

// ── ChangeContract scope decision (pure over loaded state) ──────────────────
/**
 * Enforce a work item ChangeContract's scope on one repo-relative edit path.
 * - whitelist mode (cleanup profile): the edit MUST fall inside allowed_scope.
 * - blacklist mode (default): only forbidden_scope blocks.
 * Returns undefined to allow (including every absent-precondition fall-through).
 */
export function contractScopeDecision(
  contract: AcgChangeContract,
  repoRel: string,
  archSpec: AcgArchitectureSpec | undefined,
): PreToolDecision | undefined {
  if (contract.scope_mode === 'whitelist' && contract.allowed_scope.length > 0) {
    const allowed = contract.allowed_scope.some((ref) => scopeRefMatches(ref, repoRel, archSpec));
    if (!allowed) {
      return blockDecision(
        'tidy-scope',
        `${repoRel} is outside this tidy contract's allowed_scope (whitelist: allowed=diff, forbidden=그외)`,
      );
    }
    return undefined;
  }

  if (contract.forbidden_scope.length === 0) return undefined;
  const hit = matchForbiddenScope(contract.forbidden_scope, repoRel, archSpec);
  if (hit) {
    return blockDecision(
      'forbidden-scope',
      `${repoRel} is in this work item's forbidden_scope (${hit.kind}:${hit.ref})`,
    );
  }
  return undefined;
}

// ── autopilot active-node lease decision (pure over loaded state) ───────────
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
 * Node kinds whose in-flight lease also covers `tests/**`: a mutating node's
 * packet routinely assigns the RED test file alongside its src file_scope, but
 * dispatched leases register only the src side.
 */
const TESTS_ALLOW_NODE_KINDS: ReadonlySet<string> = new Set(['implement', 'fix', 'refactor']);

export type LeaseGateDecision =
  | { verdict: 'allow' }
  | { verdict: 'block'; category: string; reason: string }
  /** Out-of-scope edit let through by the explicit bypass — the shell must audit-log it. */
  | { verdict: 'bypass-allow' };

export interface LeaseGateState {
  repoRel: string;
  leases: ActiveNodeLease[];
  nodes: Autopilot['nodes'];
  bypassActive: boolean;
}

/**
 * Allow-list lease check, pure over the loaded graph + leases. Fail-open cases
 * (derived scope, fully-terminal graph, only read-only empty leases) return
 * 'allow'; an out-of-scope edit blocks unless the audited bypass is active.
 */
export function leaseGateDecision(state: LeaseGateState): LeaseGateDecision {
  const { repoRel, leases, nodes, bypassActive } = state;

  const hasNonTerminal = nodes.some(
    (n) => n.status === 'pending' || n.status === 'running' || n.status === 'blocked',
  );
  if (!hasNonTerminal) return { verdict: 'allow' }; // fail-open: graph fully terminal

  if (leases.length === 0) return { verdict: 'allow' }; // fail-open: nothing dispatched

  // A derived-scope lease's file_scope is the dispatch fallback (changed_files) —
  // a concurrency heuristic, not the node's intended write set; the allow-list is
  // only enforceable when EVERY active lease declares its scope.
  if (leases.some((l) => l.scope_source === 'derived')) return { verdict: 'allow' };

  // A READ-ONLY node dispatched with an EMPTY declared file_scope declares no
  // write-set; its empty scope must not build an empty allow-list that
  // hard-blocks every edit. A MUTATING node's empty declared scope stays a
  // deny-all (the scope-guard bypass, inverted).
  const enforceable = leases.filter((l) => {
    if (l.file_scope.length > 0) return true;
    const kind = nodes.find((n) => n.id === l.node_id)?.kind;
    return kind === undefined || isMutatingOwner(kindToOwner(kind));
  });
  if (enforceable.length === 0) return { verdict: 'allow' }; // only read-only empty leases active

  const inScope = enforceable.some((l) => fileScopeContains(l.file_scope, repoRel));
  if (inScope) return { verdict: 'allow' };

  // tests/** companion allowance: deterministic ALLOW (not the audited bypass)
  // while some active lease belongs to a MUTATING node kind.
  if (
    repoRel.startsWith('tests/') &&
    leases.some((l) =>
      TESTS_ALLOW_NODE_KINDS.has(nodes.find((n) => n.id === l.node_id)?.kind ?? ''),
    )
  ) {
    return { verdict: 'allow' };
  }

  if (bypassActive) return { verdict: 'bypass-allow' };
  return {
    verdict: 'block',
    category: 'autopilot-path',
    reason: `${repoRel} is outside every active autopilot node's file_scope (${leases
      .map((l) => l.node_id)
      .join(', ')}); edit inside the dispatched node's scope or set DITTO_AUTOPILOT_BYPASS=1`,
  };
}
