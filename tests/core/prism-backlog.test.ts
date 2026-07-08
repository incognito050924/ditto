import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeBacklogSplit, proposeBacklogSplit } from '~/core/prism/backlog';
import type { DesignDocInput } from '~/core/prism/designdoc';
import { PrismStore } from '~/core/prism/store';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * prism backlog-split mechanism (wi_260707oi1, ac-8). The mechanism exercised with
 * fixtures: a confirmed design doc → a multi-WI split proposal → a user-approval
 * primitive (the user's own words, not a bare CLI call) → per-item WI-draft
 * materialization. No intent.json at materialize (no-auto-drive), idempotent per
 * item, 0·1 boundaries, each item carries its own AC + verification method, no
 * GitHub writes.
 */

const PARENT = 'wi_prismbacklog01';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-prism-backlog-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** A minimal CONFIRMED design doc (all compile-input sections carry real content). */
function confirmedDoc(): DesignDocInput {
  return {
    feature: 'prism 재설계',
    summary: '의도 정련 표면을 prism으로 재설계한다.',
    goals: ['백로그를 승인 후에만 분할한다'],
    nonGoals: ['GitHub 쓰기'],
    acceptanceCriteria: [{ id: 'ac-1', statement: '승인 후에만 물화', evidence: '테스트' }],
    risks: [{ risk: '자동 착수', handling: 'draft만 생성' }],
  };
}

/** Two well-formed split items, each with a real AC + verification method. */
function twoItems() {
  return [
    {
      title: '승인 프리미티브',
      goal: '사용자 원문 승인만 물화를 허용한다',
      acceptance_criteria: [
        {
          statement: '원문 statement 없는 물화는 거부된다',
          verification_method: 'dynamic_test' as const,
        },
      ],
    },
    {
      title: 'no-auto-drive',
      goal: '물화는 draft만 만든다',
      acceptance_criteria: [
        {
          statement: 'materialize 시 intent.json은 쓰이지 않는다',
          verification_method: 'dynamic_test' as const,
        },
      ],
    },
  ];
}

const APPROVAL = {
  confirmed: true as const,
  statement: '두 갈래로 쪼개서 진행하자. 승인한다.',
  approved_by: 'user',
  approved_at: '2026-07-07T00:00:00.000Z',
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('proposeBacklogSplit — (a) proposal from a confirmed design doc', () => {
  test('produces a split proposal from a confirmed design doc + well-formed items', () => {
    const result = proposeBacklogSplit(confirmedDoc(), twoItems());
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') return;
    expect(result.items.map((i) => i.title)).toEqual(['승인 프리미티브', 'no-auto-drive']);
  });

  test('an unconfirmed (empty) design doc is REJECTED (cannot split an empty backlog)', () => {
    const empty: DesignDocInput = {
      feature: '',
      summary: '',
      goals: [],
      nonGoals: [],
      acceptanceCriteria: [],
      risks: [],
    };
    const result = proposeBacklogSplit(empty, twoItems());
    expect(result.status).toBe('rejected');
  });

  test('(5) a vague / placeholder AC statement is REJECTED (no placeholder leak)', () => {
    const vague = [
      {
        title: '뭔가',
        goal: '대충',
        acceptance_criteria: [
          {
            statement: 'TBD — derive observable criteria during interview/planning',
            verification_method: 'dynamic_test' as const,
          },
        ],
      },
    ];
    const result = proposeBacklogSplit(confirmedDoc(), vague);
    expect(result.status).toBe('rejected');
  });
});

describe('materializeBacklogSplit — approval primitive (b)/(c)', () => {
  test('(b) materialize is REJECTED without a user-statement approval primitive', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), twoItems());
    expect(proposal.status).toBe('proposed');
    if (proposal.status !== 'proposed') return;
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });

    // A bare invocation (confirmed=false / empty statement) is NOT approval.
    const bare = {
      confirmed: false as const,
      statement: '',
      approved_by: 'user',
      approved_at: APPROVAL.approved_at,
    };
    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: bare,
    });
    expect(result.status).toBe('rejected');
    // No child WIs created.
    expect((await workItems.list()).length).toBe(0);
  });

  test('(c) materialize succeeds ONLY with the user-statement approval primitive', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), twoItems());
    if (proposal.status !== 'proposed') throw new Error('proposal not proposed');
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });

    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    expect(result.status).toBe('materialized');
    if (result.status !== 'materialized') return;
    expect(result.materialized_wis.length).toBe(2);
    // The approval statement (the user's own words) is stored auditable.
    const stored = await prism.readBacklogSplit(PARENT);
    expect(stored?.approval?.statement).toBe(APPROVAL.statement);
    expect(stored?.approval?.approved_by).toBe('user');
  });
});

describe('materializeBacklogSplit — materialized item shape (d)/(e)/no-github', () => {
  test('(d) each materialized item WI carries its own AC + verification method; back-linked to parent', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), twoItems());
    if (proposal.status !== 'proposed') throw new Error('proposal not proposed');
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });
    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    if (result.status !== 'materialized') throw new Error('not materialized');

    for (const id of result.materialized_wis) {
      const wi = await workItems.get(id);
      // back-linked to the parent (child side).
      expect(wi.discovered_by).toBe(PARENT);
      // its OWN AC, non-placeholder, carrying a verification method.
      expect(wi.acceptance_criteria.length).toBeGreaterThan(0);
      const ac = wi.acceptance_criteria[0];
      expect(ac?.statement).not.toBe('TBD — derive observable criteria during interview/planning');
      expect(ac?.oracle?.verification_method).toBe('dynamic_test');
    }
  });

  test('(e) NO intent.json is written at materialize (no-auto-drive), and every child stays draft', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), twoItems());
    if (proposal.status !== 'proposed') throw new Error('proposal not proposed');
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });
    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    if (result.status !== 'materialized') throw new Error('not materialized');

    for (const id of result.materialized_wis) {
      // no per-item intent.json compiled at materialize time.
      expect(await exists(join(repo, '.ditto', 'local', 'work-items', id, 'intent.json'))).toBe(
        false,
      );
      // not auto-started: still a draft.
      const wi = await workItems.get(id);
      expect(wi.status).toBe('draft');
    }
  });
});

describe('materializeBacklogSplit — idempotency + boundaries (f)/(g)', () => {
  test('(f) a re-run creates NO duplicate work items (idempotent per item)', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), twoItems());
    if (proposal.status !== 'proposed') throw new Error('proposal not proposed');
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });
    const first = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    if (first.status !== 'materialized') throw new Error('not materialized');
    const second = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    if (second.status !== 'materialized') throw new Error('not materialized');
    // Same ids, no new WIs on the re-run.
    expect(second.materialized_wis).toEqual(first.materialized_wis);
    expect((await workItems.list()).length).toBe(2);
  });

  test('(g) a 0-item split materializes nothing (empty boundary)', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const proposal = proposeBacklogSplit(confirmedDoc(), []);
    expect(proposal.status).toBe('proposed');
    if (proposal.status !== 'proposed') return;
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });
    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    expect(result.status).toBe('materialized');
    if (result.status !== 'materialized') return;
    expect(result.materialized_wis.length).toBe(0);
    expect((await workItems.list()).length).toBe(0);
  });

  test('(g) a 1-item split materializes exactly one WI (single-item boundary)', async () => {
    const workItems = new WorkItemStore(repo);
    const prism = new PrismStore(repo);
    const one = twoItems().slice(0, 1);
    const proposal = proposeBacklogSplit(confirmedDoc(), one);
    if (proposal.status !== 'proposed') throw new Error('proposal not proposed');
    await prism.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: PARENT,
      items: proposal.items,
      materialized: [],
    });
    const result = await materializeBacklogSplit({
      workItems,
      prism,
      parentId: PARENT,
      approval: APPROVAL,
    });
    expect(result.status).toBe('materialized');
    if (result.status !== 'materialized') return;
    expect(result.materialized_wis.length).toBe(1);
    expect((await workItems.list()).length).toBe(1);
  });
});

describe('ditto prism backlog CLI — the user-facing approval gate (ac-8)', () => {
  const cliEntry = join(process.cwd(), 'src/cli/index.ts');

  function git(cwd: string, argv: string[]): void {
    execFileSync('git', argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  function spawn(
    cwd: string,
    argv: string[],
  ): { stdout: string; stderr: string; exitCode: number | null } {
    const proc = Bun.spawnSync(['bun', cliEntry, ...argv], { cwd, env: { ...process.env } });
    return {
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
      exitCode: proc.exitCode,
    };
  }

  async function setupRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-prism-backlog-cli-'));
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@t.test']);
    git(dir, ['config', 'user.name', 't']);
    await mkdir(join(dir, '.ditto'), { recursive: true });
    const payload = { doc: confirmedDoc(), items: twoItems() };
    await writeFile(join(dir, 'payload.json'), JSON.stringify(payload), 'utf8');
    return dir;
  }

  test('a bare materialize (no --statement) is REJECTED; propose→materialize with a statement succeeds', async () => {
    const dir = await setupRepo();
    try {
      const proposed = spawn(dir, [
        'prism',
        'backlog',
        'propose',
        '--wi',
        PARENT,
        '--input',
        'payload.json',
        '--output',
        'json',
      ]);
      expect(proposed.exitCode).toBe(0);
      expect(JSON.parse(proposed.stdout).proposed).toBe(2);

      // Bare CLI invocation (no --statement) is NOT approval → rejected, nothing materialized.
      const bare = spawn(dir, ['prism', 'backlog', 'materialize', '--wi', PARENT]);
      expect(bare.exitCode).not.toBe(0);

      // WITH the user's own statement → materializes two draft WIs.
      const done = spawn(dir, [
        'prism',
        'backlog',
        'materialize',
        '--wi',
        PARENT,
        '--statement',
        '두 갈래로 쪼개자. 승인.',
        '--output',
        'json',
      ]);
      expect(done.exitCode).toBe(0);
      expect(JSON.parse(done.stdout).materialized_wis.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
