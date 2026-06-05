import { isAbsolute, relative, resolve } from 'node:path';
import { matchForbiddenScope } from '~/acg/scope/resolve';
import { ChangeContractStore } from '~/core/change-contract-store';
import { readArchitectureSpec } from '~/core/fs';
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

const HOME = process.env.HOME ?? '';

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

function checkDestructive(cmd: string) {
  const normalized = cmd.replace(/\s+/g, ' ').trim();

  // fork bomb
  if (normalized.replace(/\s/g, '').includes(':(){:|:&};:')) {
    return block('destructive', 'fork bomb');
  }
  // disk-destroying primitives
  if (/\bmkfs\.?\w*/.test(normalized)) return block('destructive', 'mkfs on a device');
  if (/\bdd\b[^;&|]*\bof=\/dev\//.test(normalized)) return block('destructive', 'dd to a device');
  if (/>\s*\/dev\/sd/.test(normalized)) return block('destructive', 'overwrite of a block device');

  // sudo + dangerous primitive
  if (/\bsudo\b/.test(normalized) && /\bsudo\b[^;&|]*\b(rm|dd|mkfs\.?\w*)\b/.test(normalized)) {
    return block('destructive', 'sudo with a destructive command');
  }

  // force-push to a default branch
  if (
    /\bgit\b[^;&|]*\bpush\b/.test(normalized) &&
    /(--force-with-lease|--force|(^|\s)-\w*f)/.test(normalized) &&
    /\b(main|master)\b/.test(normalized)
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

    // (c) best-effort static redirect / copy destination
    for (const dest of bashWriteTargets(command)) {
      if (isOutsideRepo(repoRoot, dest)) {
        return block('scope-out', `write outside repo (${dest})`);
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

  // (c) scope-out write
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    if (isOutsideRepo(repoRoot, filePath)) {
      return block('scope-out', `write outside repo (${filePath})`);
    }
    // (d) forbidden_scope: 계약이 보호하는 파일을 건드리면 막는다.
    const forbidden = await checkForbiddenScope(input, filePath);
    if (forbidden) return forbidden;
  }

  return ALLOW;
};

/** Statically extractable write destinations from a Bash command (else none). */
function bashWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  // redirections: `> path` / `>> path`
  for (const m of cmd.matchAll(/>>?\s*([^\s;&|>]+)/g)) {
    const t = m[1];
    if (t && !t.startsWith('/dev/') && !/[$`*]/.test(t)) out.push(t);
  }
  // `tee path`
  for (const m of cmd.matchAll(/\btee\b\s+(?:-\S+\s+)*([^\s;&|]+)/g)) {
    const t = m[1];
    if (t && !/[$`*]/.test(t)) out.push(t);
  }
  // `cp src dest` / `mv src dest` — last token is the destination
  for (const m of cmd.matchAll(/\b(?:cp|mv)\b([^;&|]*)/g)) {
    const args = (m[1] ?? '')
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0 && !a.startsWith('-'));
    const dest = args[args.length - 1];
    if (dest && args.length >= 2 && !/[$`*]/.test(dest)) out.push(dest);
  }
  return out;
}
