import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * External completion authority (Invariant: maker≠checker). Cross-verifies a
 * claim by calling the `codex` CLI directly (a SEPARATE process running a
 * different model — real independence). fail-closed: only an explicit
 * "VERDICT: verified" upgrades; codex absent, a non-zero exit, an ambiguous
 * reply, or an explicit refutation all withhold the upgrade.
 */

export type CrossCheckOutcome = 'verified' | 'refuted' | 'unverified';

export interface CrossCheckResult {
  outcome: CrossCheckOutcome;
  detail: string;
  codexAvailable: boolean;
}

// Injected boundary so both paths are deterministically testable without an LLM.
export interface CodexDeps {
  which(bin: string): string | null;
  run(args: string[]): { exitCode: number; lastMessage: string; stderr: string };
}

/** Only a positive external verdict may upgrade an item/AC to pass. */
export function upgradesToPass(outcome: CrossCheckOutcome): boolean {
  return outcome === 'verified';
}

function parseVerdict(text: string): CrossCheckOutcome {
  const refuted = /VERDICT:\s*refuted/i.test(text);
  const verified = /VERDICT:\s*verified/i.test(text);
  // fail-closed toward blocking: any refutation wins over a verify.
  if (refuted) return 'refuted';
  if (verified) return 'verified';
  return 'unverified';
}

export function buildPrompt(input: { claim: string; evidence: string }): string {
  return [
    'You are an INDEPENDENT checker (maker != checker). Do not trust the claim.',
    'Decide only from the stated evidence whether the claim holds.',
    `CLAIM: ${input.claim}`,
    `EVIDENCE: ${input.evidence}`,
    'Reply with a one-line reason, then end with exactly one final line:',
    '"VERDICT: verified" if the evidence supports the claim, otherwise "VERDICT: refuted".',
  ].join('\n');
}

export function codexCrossCheck(
  input: { claim: string; evidence: string },
  deps: CodexDeps,
): CrossCheckResult {
  const path = deps.which('codex');
  if (path === null) {
    return {
      outcome: 'unverified',
      detail: 'codex CLI absent on PATH → fail-closed (item stays unverified)',
      codexAvailable: false,
    };
  }

  const outFile = join(mkdtempSync(join(tmpdir(), 'codex-xcheck-')), 'last.txt');
  const args = [
    'exec',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '-o',
    outFile,
    buildPrompt(input),
  ];
  const { exitCode, lastMessage, stderr } = deps.run(args);

  if (exitCode !== 0) {
    return {
      outcome: 'unverified',
      detail: `codex exec exit ${exitCode} → fail-closed: ${stderr.slice(-200)}`,
      codexAvailable: true,
    };
  }

  const outcome = parseVerdict(lastMessage);
  return {
    outcome,
    detail: `codex verdict: ${outcome} (${lastMessage.trim().slice(-200)})`,
    codexAvailable: true,
  };
}

/**
 * Live CodexDeps backed by the real `codex` CLI. `-o` writes only the final
 * agent message, which we read back as the parse target.
 */
export const liveCodexDeps: CodexDeps = {
  which: (bin) => Bun.which(bin),
  run: (args) => {
    // The `-o <file>` flag is the second-to-last-known arg pair; recover its path.
    const oIdx = args.indexOf('-o');
    const outFile = oIdx >= 0 ? args[oIdx + 1] : undefined;
    const proc = Bun.spawnSync(['codex', ...args]);
    let lastMessage = new TextDecoder().decode(proc.stdout);
    if (outFile) {
      try {
        lastMessage = readFileSync(outFile, 'utf8');
      } catch {
        /* fall back to stdout */
      } finally {
        rmSync(join(outFile, '..'), { recursive: true, force: true });
      }
    }
    return {
      exitCode: proc.exitCode ?? 1,
      lastMessage,
      stderr: new TextDecoder().decode(proc.stderr),
    };
  },
};
