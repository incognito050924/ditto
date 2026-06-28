import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBoardLines, loadBoardView } from '~/cli/commands/work';
import { createFakeGhClient } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';

// ac-6 (wi_260628d79, G5/G7): `ditto work status` surfaces the linked issue coord +
// board position (status/priority) and DIVERGENCE when the board status (GitHub is
// SoT on the priority axis, read-only) disagrees with the WI status (ditto is SoT on
// the completion axis, write). The board read is an injectable seam (OBJ-3): a FAKE
// GhClient feeds a board status; no `gh` subprocess. The no-link clean case runs the
// real CLI (a WI with no github_issue -> no gh call at all).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');

// `gh project field-list --format json` shape: the Status single-select option ids
// the D7 status_map points at, plus their display names (id->name bridge).
const FIELD_LIST = {
  fields: [
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_done', name: 'Done' },
        { id: 'opt_dropped', name: 'Dropped' },
      ],
    },
    {
      id: 'PVTSSF_prio',
      name: 'Priority',
      type: 'ProjectV2SingleSelectField',
      options: [{ id: 'opt_p1', name: 'P1' }],
    },
  ],
};

// `gh project item-list --format json` shape: each item carries its content (issue
// number/repo) + the single-select field values flattened to lowercased field names.
function itemListWith(status: string, priority: string, issueNumber = 42) {
  return {
    items: [
      {
        id: 'PVTI_1',
        content: { type: 'Issue', number: issueNumber, repository: 'owner/app' },
        status,
        priority,
      },
    ],
    totalCount: 1,
  };
}

function cfg(): DittoConfigGithub {
  return {
    project: { owner: 'owner', number: 5, node_id: 'PVT_p' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    auto_reflect: false,
  };
}

function wi(status: WorkItem['status']): WorkItem {
  return {
    id: 'wi_x',
    title: 'T',
    goal: 'g',
    status,
    acceptance_criteria: [{ id: 'ac-1', statement: 'x', verdict: 'unverified', evidence: [] }],
    github_issue: { repo: 'owner/app', number: 42 },
  } as unknown as WorkItem;
}

describe('ac-6 work status — board position + divergence', () => {
  test('aligned: board Done == WI done -> coord + board shown, no divergence', () => {
    const { client } = createFakeGhClient({
      values: { projectItemList: itemListWith('Done', 'P1'), projectFieldList: FIELD_LIST },
    });
    const view = loadBoardView({ client, config: cfg() }, wi('done'));
    expect(view.coord).toBe('owner/app#42');
    expect(view.position?.status).toBe('Done');
    expect(view.position?.priority).toBe('P1');
    expect(view.divergence.diverged).toBe(false);
    const out = formatBoardLines(view).join('\n');
    expect(out).toContain('owner/app#42');
    expect(out).toContain('Done');
    expect(out).toContain('completion = ditto');
    expect(out).not.toContain('DIVERGENCE');
  });

  test('diverged: board Done but WI in_progress -> divergence line present', () => {
    const { client } = createFakeGhClient({
      values: { projectItemList: itemListWith('Done', 'P1'), projectFieldList: FIELD_LIST },
    });
    const view = loadBoardView({ client, config: cfg() }, wi('in_progress'));
    expect(view.divergence.diverged).toBe(true);
    const out = formatBoardLines(view).join('\n');
    expect(out).toContain('owner/app#42'); // coord
    expect(out).toContain('Done'); // board status surfaced
    expect(out).toContain('DIVERGENCE'); // divergence line
    expect(out).toContain('in_progress'); // WI status named in the divergence line
  });

  test('gh degraded: coord shown, board unavailable + reason; never throws', () => {
    const { client } = createFakeGhClient({
      degrade: { ok: false, reason: 'unauthenticated', detail: 'gh auth login' },
    });
    const view = loadBoardView({ client, config: cfg() }, wi('in_progress'));
    expect(view.position).toBeNull();
    expect(view.unavailable?.reason).toBe('unauthenticated');
    const out = formatBoardLines(view).join('\n');
    expect(out).toContain('owner/app#42');
    expect(out.toLowerCase()).toContain('unavailable');
  });

  test('no github_issue link -> work status shows no github section, no error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-ghstatus-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
    try {
      const created = await new WorkItemStore(dir).create({
        title: 'no link',
        source_request: 'r',
        goal: 'g',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
        ],
      });
      const proc = Bun.spawnSync(['bun', cliEntry, 'work', 'status', created.id], {
        cwd: dir,
        env: { ...process.env },
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout?.toString() ?? '';
      expect(out).not.toContain('github:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
