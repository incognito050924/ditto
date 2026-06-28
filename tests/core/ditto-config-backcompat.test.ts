import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readGithubConfig, writeGithubConfig } from '~/core/ditto-config';
import { workItem } from '~/schemas/work-item';

// wi_2606287v9 (#5) ac-11: back-compat in BOTH directions for the new claim /
// non-terminal-board fields.
//   (1) OLD data -> NEW schema: a work-item.json without claim markers and a github
//       config with terminal-only status_map both load unchanged.
//   (2) NEW data -> OLD schema (the failing direction the pre-mortem found): a config
//       carrying the non-terminal mapping, parsed by a terminal-only schema, still
//       loads tech_spec/deep_interview AND degrades the non-terminal mapping per-key —
//       it must NOT drop the whole github block.

function workItemLiteral(extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    id: 'wi_test0001',
    title: 'a work item',
    source_request: 'do the thing',
    goal: 'the outcome is observable',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'an observable behavior',
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
    status: 'draft' as const,
    owner_profile: 'workspace-write' as const,
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('OLD data -> NEW schema (wi_2606287v9 ac-11)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-bc-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('a pre-existing work-item.json WITHOUT claim markers loads unchanged', () => {
    const parsed = workItem.parse(
      workItemLiteral({ github_issue: { repo: 'owner/name', number: 7 } }),
    );
    expect(parsed.github_issue?.repo).toBe('owner/name');
    expect(parsed.github_issue?.claimed_branch).toBeUndefined();
    expect(parsed.github_issue?.posted_claim_markers).toBeUndefined();
  });

  test('a github config with terminal-only status_map round-trips (no claim_status_map injected)', async () => {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        github: {
          project: { owner: 'o', number: 5 },
          status_map: { done: 'd', abandoned: 'a' },
          auto_reflect: false,
        },
      }),
      'utf8',
    );
    const gh = await readGithubConfig(repo);
    expect(gh?.status_map).toEqual({ done: 'd', abandoned: 'a' });
    expect(gh?.claim_status_map).toBeUndefined();
  });

  test('writeGithubConfig + readGithubConfig round-trip the claim_status_map (ac-9)', async () => {
    const gh = {
      project: { owner: 'o', number: 5 },
      status_map: { done: 'd', abandoned: 'a' },
      claim_status_map: { in_progress: 'opt_wip', blocked: 'opt_blocked' },
      auto_reflect: false,
    };
    await writeGithubConfig(repo, gh);
    expect(await readGithubConfig(repo)).toEqual(gh);
  });
});

describe('NEW data -> OLD schema: per-key degradation, not whole-config drop (wi_2606287v9 ac-11)', () => {
  // Reconstruct the PRE-CHANGE schema inline: terminal-only github status_map, NO
  // claim_status_map field. This simulates an old/stale bundle reading a config the
  // NEW writer produced.
  const oldGithub = z.object({
    project: z.object({
      owner: z.string().min(1),
      number: z.number().int().positive(),
      node_id: z.string().min(1).optional(),
    }),
    status_map: z.record(z.enum(['done', 'abandoned']), z.string().min(1)),
    auto_reflect: z.boolean(),
  });
  const oldConfig = z.object({
    tech_spec: z.object({ question: z.record(z.string(), z.unknown()).optional() }).optional(),
    deep_interview: z.record(z.string(), z.unknown()).optional(),
    github: oldGithub.optional(),
  });

  const newConfig = {
    tech_spec: { question: { generators: 3 } },
    deep_interview: { generators: 4 },
    github: {
      project: { owner: 'o', number: 5 },
      status_map: { done: 'd', abandoned: 'a' },
      claim_status_map: { in_progress: 'opt_wip', blocked: 'opt_blocked' },
      auto_reflect: true,
    },
  };

  test('the OLD schema parses the NEW config (no throw, no whole-config drop)', () => {
    expect(oldConfig.safeParse(newConfig).success).toBe(true);
  });

  test('siblings tech_spec/deep_interview survive (NOT poisoned)', () => {
    const r = oldConfig.parse(newConfig);
    expect(r.tech_spec).toBeDefined();
    expect(r.deep_interview).toBeDefined();
  });

  test('the github block survives; the non-terminal mapping is degraded (stripped) per-key', () => {
    const r = oldConfig.parse(newConfig);
    expect(r.github).toBeDefined();
    expect(r.github?.status_map).toEqual({ done: 'd', abandoned: 'a' });
    // the unknown non-terminal field is stripped by the old (non-strict) schema — a
    // per-key skip, never a whole-config drop.
    expect((r.github as Record<string, unknown>).claim_status_map).toBeUndefined();
  });

  test('CONTRAST: extending the terminal enum WOULD reject the whole record (rejected design)', () => {
    const terminalRecord = z.record(z.enum(['done', 'abandoned']), z.string().min(1));
    expect(terminalRecord.safeParse({ done: 'd', abandoned: 'a', in_progress: 'p' }).success).toBe(
      false,
    );
  });
});
