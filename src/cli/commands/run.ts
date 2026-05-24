import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { captureGitState } from '~/core/git';
import { RunStore } from '~/core/run-store';
import { RunWithRuntimeError, RunWithUsageError, runWithProvider } from '~/core/run-with';
import { WorkItemStore } from '~/core/work-item-store';
import { profileName, providerName } from '~/schemas/common';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  extractDashDashTail,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

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

const runWith = defineCommand({
  meta: {
    name: 'with',
    description: 'Run a provider command and capture it as a recorded run',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Runnable provider name: codex|claude-code',
      required: true,
    },
    profile: {
      type: 'string',
      description: 'Execution profile',
      default: 'workspace-write',
    },
    workItem: {
      type: 'string',
      description: 'Work item id to attach this run to',
      required: true,
    },
    prompt: {
      type: 'string',
      description: 'Repo-relative prompt/context packet path',
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
    const tail = extractDashDashTail();
    if (tail === null || tail.length === 0) {
      writeError(
        'ditto run with requires provider args after `--`. Example: ditto run with --provider codex --work-item wi_... -- exec --help',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const provider = providerName.safeParse(args.provider);
      if (!provider.success) {
        throw new RunWithUsageError(`invalid --provider value: ${args.provider}`);
      }
      const profile = profileName.safeParse(args.profile);
      if (!profile.success) {
        throw new RunWithUsageError(`invalid --profile value: ${args.profile}`);
      }
      const result = await runWithProvider(repoRoot, {
        work_item_id: args.workItem,
        provider: provider.data,
        profile: profile.data,
        args: tail,
        ...(args.prompt ? { prompt_path: args.prompt } : {}),
      });
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`Captured run ${result.run_id}`);
        writeHuman(`  work item: ${result.work_item_id}`);
        writeHuman(`  provider:  ${result.provider}`);
        writeHuman(`  profile:   ${result.profile}`);
        writeHuman(`  exit_code: ${result.exit_code ?? 'null'}`);
        writeHuman(`  manifest:  ${repoRoot}/${result.manifest_path}`);
      }
      if (result.exit_code !== null && result.exit_code !== 0) {
        process.exit(result.exit_code);
      }
      if (result.exit_code === null) {
        process.exit(RUNTIME_ERROR_EXIT);
      }
    } catch (err) {
      if (err instanceof RunWithUsageError) {
        writeError(`run with failed: ${err.message}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      if (err instanceof RunWithRuntimeError) {
        writeError(`run with failed: ${err.message}`);
        if (format === 'json' && err.result) writeJson(err.result);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      writeError(`run with failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
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
    with: runWith,
  },
});
