import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { captureGitState } from '~/core/git';
import { RunStore } from '~/core/run-store';
import { WorkItemStore } from '~/core/work-item-store';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

const runRecord = defineCommand({
  meta: {
    name: 'record',
    description: 'Attach a provider invocation to a work item as a recorded run',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to attach this run to',
      required: true,
    },
    provider: {
      type: 'string',
      description: 'Provider name: codex|claude-code|opencode|openagent|other',
      required: true,
    },
    profile: {
      type: 'string',
      description: 'Execution profile',
      default: 'workspace-write',
    },
    entrypoint: {
      type: 'string',
      description: 'How the provider was invoked',
      required: false,
    },
    model: {
      type: 'string',
      description: 'Model reported by the provider; "" or omitted → null',
      required: false,
    },
    prompt: {
      type: 'string',
      description: 'Path to prompt/context packet file',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    const repoRoot = await resolveRepoRootForCreate();
    const workStore = new WorkItemStore(repoRoot);
    const runStore = new RunStore(repoRoot);
    try {
      const item = await workStore.get(args.workId);
      const provider = args.provider as
        | 'codex'
        | 'claude-code'
        | 'opencode'
        | 'openagent'
        | 'other';
      const profile = args.profile as
        | 'read-only'
        | 'workspace-write'
        | 'networked'
        | 'reviewer'
        | 'isolated';
      const git = captureGitState(repoRoot);
      const created = await runStore.create({
        work_item_id: item.id,
        provider,
        entrypoint: args.entrypoint ?? `${provider}`,
        profile,
        cwd: '.',
        model_reported: args.model && args.model.length > 0 ? args.model : null,
        git_before: {
          head: git.head,
          branch: git.branch,
          dirty: git.dirty,
          untracked_count: git.untracked_count,
        },
        ...(args.prompt ? { prompt_path: args.prompt } : {}),
      });
      await workStore.update(item.id, (cur) => ({
        ...cur,
        runs: [...cur.runs, created.id],
      }));
      if (format === 'json') {
        writeJson({
          run_id: created.id,
          work_item_id: item.id,
          manifest_path: `.ditto/runs/${created.id}/manifest.json`,
          provider: created.provider,
          profile: created.profile,
        });
      } else {
        writeHuman(`Recorded run ${created.id}`);
        writeHuman(`  work item: ${item.id}`);
        writeHuman(`  provider:  ${created.provider}`);
        writeHuman(`  profile:   ${created.profile}`);
        writeHuman(`  manifest:  ${repoRoot}/.ditto/runs/${created.id}/manifest.json`);
      }
    } catch (err) {
      writeError(`run record failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Record and inspect provider runs',
  },
  subCommands: {
    record: runRecord,
  },
});
