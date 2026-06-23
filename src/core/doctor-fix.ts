import { join } from 'node:path';
import { syncClaudeCodeProjection } from './bridge-sync';
import { ensureDir } from './fs';
import { fileExists } from './hosts/shared';
import type { InstructionFinding } from './instruction-bridge';
import { writeBackupOnce } from './managed-resource';
import { allowlistSettingsFile } from './settings-allowlist';

/**
 * `ditto doctor --fix` repair core. Pure planning/classification plus injected
 * fs/TTY effects, so the repair decision logic is unit-testable without real
 * fs or a terminal (the codeql InstallDeps / wizard PromptIO injection pattern).
 *
 * Detection is NOT re-implemented here — callers feed already-detected drift
 * (instruction findings, the distribution allowlist check) in. This module only
 * decides what to repair, classifies reversibility, and applies the repairs.
 */

export type FixKind = 'instruction-projection' | 'allowlist' | 'register-variant';

export interface FixItem {
  kind: FixKind;
  /**
   * Reversible repairs (managed-block re-projection with a `.bak`; project-level
   * allowlist) auto-apply. Non-reversible repairs — primarily global `~/.claude`
   * host impact (ADR-0011 session-rooting) — apply only after a TTY confirm.
   */
  reversible: boolean;
  /** The file the repair writes to (used for reversibility classification). */
  targetPath: string;
  /** Human-readable one-liner for the report. */
  describe: string;
  /** For `register-variant`: the orphan variant name to register into the host. */
  variantName?: string;
}

/**
 * A repair target is reversible when it stays inside the project. Touching the
 * user's global `~/.claude` directory is non-reversible host impact (ADR-0011):
 * the session is rooted at the target, so a global write reaches outside it.
 */
export function classifyReversible(targetPath: string, homeDir: string): boolean {
  const globalRoot = join(homeDir, '.claude');
  return !(targetPath === globalRoot || targetPath.startsWith(`${globalRoot}/`));
}

/**
 * Map instruction-drift findings to instruction-projection fixes. One fix per
 * distinct projection path that drifted; reversibility is classified from the
 * path. Reuses the SAME detection findings the advisory surface already produced.
 */
export function planInstructionFixes(
  findings: Pick<InstructionFinding, 'host' | 'path' | 'kind' | 'message'>[],
  homeDir: string,
): FixItem[] {
  const seen = new Set<string>();
  const items: FixItem[] = [];
  for (const finding of findings) {
    if (finding.host !== 'claude-code') continue; // only the CLAUDE.md projection is repairable here
    if (seen.has(finding.path)) continue;
    seen.add(finding.path);
    items.push({
      kind: 'instruction-projection',
      reversible: classifyReversible(finding.path, homeDir),
      targetPath: finding.path,
      describe: `re-project managed block in ${finding.path} (${finding.kind})`,
    });
  }
  return items;
}

export interface DoctorFixDeps {
  repoRoot: string;
  /** Confirm a non-reversible repair. Returns false in non-TTY (skip). */
  confirmNonReversible: (item: FixItem) => Promise<boolean>;
  /** Repair instruction drift by re-projecting the managed block, backing up once. */
  syncProjection: () => Promise<{ applied: boolean; backupPath: string | null }>;
  /** Repair the ditto allowlist drift idempotently. */
  ensureAllowlist: () => Promise<{ applied: boolean }>;
  /**
   * Register an orphan variant into the host by copying `.ditto/agents/<name>.md`
   * to `.claude/agents/<name>.md`. Idempotent: an already-present host file is
   * preserved (skipped), so re-runs and existing hand-edits are no-ops.
   */
  registerVariant: (name: string) => Promise<{ applied: boolean }>;
}

export interface ApplyFixesResult {
  applied: FixItem[];
  skipped: FixItem[];
  /** True when there was nothing fixable to begin with. */
  nothingToFix: boolean;
}

export async function applyDoctorFixes(
  deps: DoctorFixDeps,
  items: FixItem[],
): Promise<ApplyFixesResult> {
  const applied: FixItem[] = [];
  const skipped: FixItem[] = [];
  for (const item of items) {
    if (!item.reversible) {
      const ok = await deps.confirmNonReversible(item);
      if (!ok) {
        skipped.push(item);
        continue;
      }
    }
    if (item.kind === 'instruction-projection') {
      const res = await deps.syncProjection();
      if (res.applied) applied.push(item);
    } else if (item.kind === 'register-variant') {
      const res = await deps.registerVariant(item.variantName ?? '');
      if (res.applied) applied.push(item);
    } else {
      const res = await deps.ensureAllowlist();
      if (res.applied) applied.push(item);
    }
  }
  return { applied, skipped, nothingToFix: items.length === 0 };
}

/**
 * Default effectful deps: re-project via {@link syncClaudeCodeProjection} (which
 * replaces ONLY the managed block, preserving content outside it), backing up the
 * original once via {@link writeBackupOnce} before the write; allowlist via
 * {@link allowlistSettingsFile} on the project `.claude/settings.json`.
 */
export function defaultDoctorFixDeps(
  repoRoot: string,
  homeDir: string,
): DoctorFixDeps & { homeDir: string } {
  return {
    repoRoot,
    homeDir,
    confirmNonReversible: async () => false,
    syncProjection: async () => {
      const path = join(repoRoot, 'CLAUDE.md');
      // bridge-sync writes with no backup; back up the original once first.
      const backupPath = await writeBackupOnce(path);
      const result = await syncClaudeCodeProjection(repoRoot);
      const applied = result.action === 'created' || result.action === 'updated';
      return { applied, backupPath };
    },
    ensureAllowlist: async () => {
      await allowlistSettingsFile(join(repoRoot, '.claude', 'settings.json'));
      return { applied: true };
    },
    registerVariant: async (name) => {
      const dest = join(repoRoot, '.claude', 'agents', `${name}.md`);
      // Idempotent + hand-edit-safe: never clobber an existing host file
      // (matches writeAgentVariants' skip-existing in agent-variants.ts).
      if (await fileExists(dest)) return { applied: false };
      const src = join(repoRoot, '.ditto', 'agents', `${name}.md`);
      await ensureDir(join(repoRoot, '.claude', 'agents'));
      await Bun.write(dest, await Bun.file(src).text());
      return { applied: true };
    },
  };
}
