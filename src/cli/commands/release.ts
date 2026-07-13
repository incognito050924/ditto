import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { isDittoSourceRepo } from '~/core/mode-doctor';
import {
  InvalidOutputFormatError,
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

// The consumer-update entry point (matches scripts/npx-bootstrap.mjs GH_SOURCE).
// Dogfood-only surface, so a literal is acceptable; keep in step with the bootstrap.
const GH_SOURCE = 'incognito050924/ditto';

export interface ReleaseGateInput {
  /** True only inside ditto's own source repo (isDittoSourceRepo). */
  isSourceRepo: boolean;
  /** True when `git status --porcelain` is non-empty. */
  dirty: boolean;
  dryRun: boolean;
}

/**
 * Pure precondition gate. Returns a refusal reason, or null when the release may
 * proceed. Fail-closed on `isSourceRepo`: `ditto release` ships inside `bin/ditto`
 * to every consumer (the bundle is a single blob with no per-command exclusion),
 * so this runtime gate is what keeps it INERT outside the dogfood repo — it must
 * never mutate or publish from a consumer install.
 */
export function releaseGateError(input: ReleaseGateInput): string | null {
  if (!input.isSourceRepo) {
    return 'ditto release runs only in the ditto source repo (dogfood); refused — a consumer install must never cut a release';
  }
  // A dry-run mutates nothing, so a dirty tree is fine for previewing. A real
  // release must run on a clean tree so the `release: vX.Y.Z` commit carries only
  // the version bump + rebuilt bundle, never a developer's uncommitted changes.
  if (!input.dryRun && input.dirty) {
    return 'working tree has uncommitted changes — commit or stash them first, so the release commit is version-only';
  }
  return null;
}

function run(cmd: string, cmdArgs: string[], repoRoot: string): number {
  const proc = Bun.spawnSync([cmd, ...cmdArgs], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return proc.exitCode ?? 1;
}

function isDirty(repoRoot: string): boolean {
  const proc = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.stdout.toString().trim().length > 0;
}

function readVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '';
}

export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description:
      'Dogfood-only: cut a release (version bump + rebuilt bundle + commit + tag) and push it. Refused outside the ditto source repo.',
  },
  args: {
    bump: {
      type: 'positional',
      required: true,
      description: 'Version bump: major | minor | patch | X.Y.Z',
    },
    'dry-run': { type: 'boolean', default: false, description: 'Print the plan; change nothing' },
    'no-push': {
      type: 'boolean',
      default: false,
      description: 'Stop after commit + tag; do not push (push is the default)',
    },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const dryRun = args['dry-run'] === true;
      const noPush = args['no-push'] === true;

      // Fail-closed gate FIRST — before any mutation or child process.
      const gateError = releaseGateError({
        isSourceRepo: isDittoSourceRepo(repoRoot),
        dirty: isDirty(repoRoot),
        dryRun,
      });
      if (gateError) {
        writeError(`release refused: ${gateError}`);
        process.exit(USAGE_ERROR_EXIT);
      }

      // Reuse the canonical release cutter (bump 4 touchpoints + build:bin + commit
      // + tag). It owns the mechanics; this command adds the gate, push, and report.
      const releaseArgs = ['scripts/release.mjs', args.bump, ...(dryRun ? ['--dry-run'] : [])];
      const releaseStatus = run('node', releaseArgs, repoRoot);
      if (releaseStatus !== 0) {
        writeError(`release: scripts/release.mjs exited ${releaseStatus}`);
        process.exit(RUNTIME_ERROR_EXIT);
      }
      if (dryRun) {
        if (format === 'json') writeJson({ status: 'dry-run', pushed: false });
        else writeHuman('release: dry-run complete — nothing changed');
        return;
      }

      const version = readVersion(repoRoot);
      const tag = `v${version}`;

      let pushed = false;
      if (!noPush) {
        // Push runs the recipe.yaml push-gate (full `bun test`) via .githooks/pre-push;
        // a failing gate blocks the push. The commit + tag already landed locally, so
        // a blocked push leaves a recoverable state (fix, then `git push`).
        const pushStatus = run('git', ['push'], repoRoot);
        const tagStatus = pushStatus === 0 ? run('git', ['push', 'origin', tag], repoRoot) : 1;
        pushed = pushStatus === 0 && tagStatus === 0;
        if (!pushed) {
          writeError(
            `release: v${version} committed + tagged locally, but push failed (push-gate or network). Re-run: git push && git push origin ${tag}`,
          );
          process.exit(RUNTIME_ERROR_EXIT);
        }
      }

      if (format === 'json') {
        writeJson({ status: 'released', version, tag, pushed });
      } else {
        writeHuman(
          `release: v${version} ${pushed ? 'released + pushed' : 'committed + tagged (not pushed)'} (tag ${tag})`,
        );
        if (pushed) {
          writeHuman('consumers update — one command:');
          writeHuman(`  npx github:${GH_SOURCE} update`);
          writeHuman('or in a Claude Code session:');
          writeHuman('  claude plugin marketplace update ditto-local  →  /plugin update');
        } else {
          writeHuman(`push when ready:  git push && git push origin ${tag}`);
        }
      }
    } catch (err) {
      if (err instanceof InvalidOutputFormatError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
      }
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
