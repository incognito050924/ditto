import { join } from 'node:path';
import { relativePath } from '~/schemas/common';
import { atomicWriteText } from './fs';
import { captureGitState } from './git';
import { RunStore } from './run-store';
import { WorkItemStore } from './work-item-store';

export interface ContextBuildInput {
  work_item_id: string;
  output_path?: string;
}

export interface ContextBuildResult {
  work_item_id: string;
  output_path: string;
  content: string;
}

export class ContextBuildUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBuildUsageError';
  }
}

function defaultOutputPath(workItemId: string): string {
  return `.ditto/local/work-items/${workItemId}/context-packet.md`;
}

function validateOutputPath(path: string): string {
  const parsed = relativePath.safeParse(path);
  if (!parsed.success) {
    throw new ContextBuildUsageError(`invalid --output path: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export async function buildContextPacket(
  repoRoot: string,
  input: ContextBuildInput,
): Promise<ContextBuildResult> {
  const workStore = new WorkItemStore(repoRoot);
  const runStore = new RunStore(repoRoot);
  const item = await workStore.get(input.work_item_id);
  const git = captureGitState(repoRoot);
  const outputPath = validateOutputPath(input.output_path ?? defaultOutputPath(item.id));
  const runs = await Promise.all(
    item.runs.map(async (id) => {
      try {
        return await runStore.get(id);
      } catch {
        return null;
      }
    }),
  );

  const lines = [
    `# ${item.title}`,
    '',
    '## Goal',
    '',
    item.goal,
    '',
    '## Acceptance Criteria',
    '',
    ...item.acceptance_criteria.map((criterion) => {
      return `- ${criterion.id} [${criterion.verdict}] ${criterion.statement}`;
    }),
    '',
    '## Git State',
    '',
    `- head: ${git.head}`,
    `- branch: ${git.branch || '(unknown)'}`,
    `- dirty: ${git.dirty}`,
    '',
    '## Runs',
    '',
    ...(runs.length === 0
      ? ['- none']
      : runs.map((run, index) => {
          const id = item.runs[index] ?? '(unknown)';
          return run === null ? `- ${id}: missing` : `- ${run.id}: exit_code=${run.exit_code}`;
        })),
    '',
  ];
  const content = `${lines.join('\n')}`;
  await atomicWriteText(join(repoRoot, outputPath), content);
  return {
    work_item_id: item.id,
    output_path: outputPath,
    content,
  };
}
