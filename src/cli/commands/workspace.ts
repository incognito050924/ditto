import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { loadResolvedRecipe } from '~/core/recipe/load';
import { defaultHookTemplatePath } from '~/core/setup';
import { syncWorkspace } from '~/core/workspace/clone';
import { resolveResourcesDir } from '../resources';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const workspaceSync = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Assemble the multi-repo workspace: clone each recipe repos[] entry that declares a `url` into its `dir` (idempotent — same-url skip, foreign/dirty dir refused, NEVER overwritten), then install the ROOT-recipe pre-push gate hook into each clone (WS_ROOT pinned to the workspace root). Continues past a failed clone, prints a per-repo summary, exits non-zero if any clone FAILED. Auth is ambient git (public/pre-authed urls only). URL scheme allowlist + dir containment + non-interactive git are enforced.',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const workspaceRoot = await resolveRepoRootForCreate();
    const recipe = await loadResolvedRecipe(workspaceRoot, undefined, (origin, message) => {
      writeError(`recipe (${origin}) ignored — malformed: ${message}`);
    });
    const hookTemplatePath = defaultHookTemplatePath(resolveResourcesDir());
    try {
      const result = await syncWorkspace({ workspaceRoot, recipe, hookTemplatePath });
      if (format === 'json') {
        writeJson(result);
      } else if (result.outcomes.length === 0) {
        writeHuman('No recipe repos[] entries declare a url — nothing to sync.');
      } else {
        writeHuman(`Workspace sync (${result.outcomes.length} repo(s) with a url):`);
        for (const o of result.outcomes) {
          const hook = o.hook ? `\thook=${o.hook}` : '';
          const reason = o.reason ? `\t(${o.reason})` : '';
          writeHuman(`  ${o.status.toUpperCase()}\t${o.dir}\t${o.url}${hook}${reason}`);
        }
        if (result.anyFailed) {
          writeHuman('At least one clone FAILED — re-run after resolving the cause above.');
        }
      }
      // A refusal is an intentional non-destructive safety outcome (exit 0, surfaced
      // in the summary); only a genuine clone FAILURE exits non-zero.
      if (result.anyFailed) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`workspace sync failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const workspaceCommand = defineCommand({
  meta: {
    name: 'workspace',
    description:
      'Manage the multi-repo workspace declared in recipe.yaml (sync clones declared repos[] and gates them by the root recipe)',
  },
  subCommands: {
    sync: workspaceSync,
  },
});
