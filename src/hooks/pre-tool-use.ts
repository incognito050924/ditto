import { isAbsolute, relative, resolve } from 'node:path';
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
function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(p));
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

export const preToolUseHandler: HookHandler = (input: HookInput) => {
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

    // (b) secret-file reference inside a Bash command (basename-style tokens)
    for (const token of command.split(/[\s'"=]+/)) {
      if (token.length > 0 && isSecretPath(token)) {
        return block('secret', `command references a secret file (${token})`);
      }
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
