import { describe, expect, test } from 'bun:test';
import {
  type GithubSetupOptions,
  buildGithubConfig,
  extractStatusOptions,
  parseClaimStatusMapFlag,
  parseProjectRef,
  parseStatusMapFlag,
} from '~/cli/commands/github';
import type { PromptIO } from '~/cli/wizard/prompt';
import { createFakeGhClient } from '~/core/gh-client';
import { dittoConfigGithub } from '~/schemas/ditto-config';

function fakeIO(answers: string[], isTTY = true): PromptIO {
  const q = [...answers];
  return { isTTY, ask: async () => q.shift() ?? '', write: () => {} };
}

const STATUS_FIELD_LIST = {
  fields: [
    { id: 'PVTF_title', name: 'Title', type: 'ProjectV2Field' },
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_inprog', name: 'In Progress' },
        { id: 'opt_done', name: 'Done' },
        { id: 'opt_dropped', name: 'Dropped' },
      ],
    },
  ],
};

describe('parseProjectRef', () => {
  test('owner/number', () => {
    expect(parseProjectRef('incognito050924/5')).toEqual({ owner: 'incognito050924', number: 5 });
  });
  test('user project URL', () => {
    expect(parseProjectRef('https://github.com/users/incognito050924/projects/5')).toEqual({
      owner: 'incognito050924',
      number: 5,
    });
  });
  test('org project URL', () => {
    expect(parseProjectRef('https://github.com/orgs/acme/projects/12')).toEqual({
      owner: 'acme',
      number: 12,
    });
  });
  test('garbage -> null', () => {
    expect(parseProjectRef('not-a-ref')).toBeNull();
    expect(parseProjectRef('')).toBeNull();
    expect(parseProjectRef('owner/notanumber')).toBeNull();
  });
});

describe('parseStatusMapFlag - keys limited to done|abandoned (D7)', () => {
  test('valid done+abandoned', () => {
    expect(parseStatusMapFlag('done=opt_done,abandoned=opt_dropped')).toEqual({
      map: { done: 'opt_done', abandoned: 'opt_dropped' },
      dropped: [],
    });
  });
  test('non-done/abandoned key is dropped, not mapped', () => {
    const r = parseStatusMapFlag('done=opt_done,in_progress=opt_x');
    expect(r.map).toEqual({ done: 'opt_done' });
    expect(r.dropped).toEqual(['in_progress=opt_x']);
  });
});

describe('parseClaimStatusMapFlag - keys limited to in_progress|blocked (ac-9)', () => {
  test('valid in_progress+blocked', () => {
    expect(parseClaimStatusMapFlag('in_progress=opt_inprog,blocked=opt_todo')).toEqual({
      map: { in_progress: 'opt_inprog', blocked: 'opt_todo' },
      dropped: [],
    });
  });
  test('terminal key (done) is dropped here — claim map only carries non-terminal keys', () => {
    const r = parseClaimStatusMapFlag('in_progress=opt_inprog,done=opt_done');
    expect(r.map).toEqual({ in_progress: 'opt_inprog' });
    expect(r.dropped).toEqual(['done=opt_done']);
  });
});

describe('extractStatusOptions', () => {
  test('picks the Status single-select options', () => {
    expect(extractStatusOptions(STATUS_FIELD_LIST)).toEqual([
      { id: 'opt_todo', name: 'Todo' },
      { id: 'opt_inprog', name: 'In Progress' },
      { id: 'opt_done', name: 'Done' },
      { id: 'opt_dropped', name: 'Dropped' },
    ]);
  });
  test('no single-select field -> null', () => {
    expect(extractStatusOptions({ fields: [{ id: 'x', name: 'Title' }] })).toBeNull();
  });
});

describe('dittoConfigGithub schema - status_map keyed done|abandoned ONLY (D7)', () => {
  test('rejects a non-done/abandoned key', () => {
    expect(
      dittoConfigGithub.safeParse({
        project: { owner: 'o', number: 5 },
        status_map: { in_progress: 'opt_x' },
        auto_reflect: false,
      }).success,
    ).toBe(false);
  });
  test('accepts done/abandoned (and partial/empty)', () => {
    expect(
      dittoConfigGithub.safeParse({
        project: { owner: 'o', number: 5 },
        status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
        auto_reflect: false,
      }).success,
    ).toBe(true);
    expect(
      dittoConfigGithub.safeParse({
        project: { owner: 'o', number: 5 },
        status_map: {},
        auto_reflect: false,
      }).success,
    ).toBe(true);
  });
});

describe('buildGithubConfig - ac-14 (interactive == flag, idempotent)', () => {
  test('interactive (PromptIO + fake gh) and non-interactive flags produce IDENTICAL config', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });

    // Interactive select order: project, done, abandoned, in_progress, blocked, auto-reflect.
    // choiceOptions index: 1='(none)', 2=opt_todo, 3=opt_inprog, 4=opt_done, 5=opt_dropped.
    const interactive = await buildGithubConfig(
      fakeIO(['incognito050924/5', '4', '5', '3', '2', '']),
      client,
      { nonInteractive: false },
    );

    const flags: GithubSetupOptions = {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done,abandoned=opt_dropped',
      claimStatusMap: 'in_progress=opt_inprog,blocked=opt_todo',
      autoReflect: false,
    };
    const noninteractive = await buildGithubConfig(fakeIO([]), client, flags);

    expect(interactive.ok).toBe(true);
    expect(noninteractive.ok).toBe(true);
    if (interactive.ok && noninteractive.ok) {
      expect(interactive.config).toEqual(noninteractive.config);
      expect(interactive.config).toEqual({
        project: { owner: 'incognito050924', number: 5 },
        status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
        claim_status_map: { in_progress: 'opt_inprog', blocked: 'opt_todo' },
        auto_reflect: false,
      });
    }
  });

  // ac-9: a re-run with identical inputs yields a byte-identical config (canonical key
  // order in both status_map and claim_status_map — JSON.stringify must match exactly).
  test('ac-9 re-run with same flags is idempotent (byte-identical JSON)', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
    const flags: GithubSetupOptions = {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done,abandoned=opt_dropped',
      claimStatusMap: 'blocked=opt_todo,in_progress=opt_inprog',
      autoReflect: false,
    };
    const a = await buildGithubConfig(fakeIO([]), client, flags);
    const b = await buildGithubConfig(fakeIO([]), client, flags);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(a.config)).toBe(JSON.stringify(b.config));
      // claim_status_map key order is canonical (in_progress before blocked) regardless
      // of the order the flag listed them.
      expect(JSON.stringify(a.config.claim_status_map)).toBe(
        JSON.stringify({ in_progress: 'opt_inprog', blocked: 'opt_todo' }),
      );
    }
  });

  // ac-9: each claim option id is re-checked against the live Project status options;
  // an id that is not a real option is skipped with a notice (terminal path's guard).
  test('ac-9 invalid claim option id is skipped with a notice (live option re-check)', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      claimStatusMap: 'in_progress=opt_inprog,blocked=opt_nonexistent',
      autoReflect: false,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.claim_status_map).toEqual({ in_progress: 'opt_inprog' });
      expect(outcome.notices.join(' ')).toContain('opt_nonexistent');
    }
  });

  // ac-9: a terminal key handed to --claim-status-map is dropped (notice); terminal
  // status_map continues to work unchanged via --status-map.
  test('ac-9 claim flag drops terminal keys; terminal status_map unaffected', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done',
      claimStatusMap: 'in_progress=opt_inprog,done=opt_done',
      autoReflect: false,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.status_map).toEqual({ done: 'opt_done' });
      expect(outcome.config.claim_status_map).toEqual({ in_progress: 'opt_inprog' });
      expect(outcome.notices.join(' ')).toContain('done=opt_done');
    }
  });

  // ac-9: terminal-only setup (no claim flag) omits claim_status_map entirely — the
  // separate optional field is absent, not an empty object (back-compat preserved).
  test('ac-9 terminal-only config omits claim_status_map (no empty object)', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done,abandoned=opt_dropped',
      autoReflect: false,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.claim_status_map).toBeUndefined();
      expect(Object.keys(outcome.config)).not.toContain('claim_status_map');
    }
  });

  // wi_260628p46: setup MUST persist the Project node_id — reflection's board status
  // update (ac-5) requires cfg.project.node_id; without it the board update is skipped
  // even when project_item_id is present. setup is the only place to capture it.
  test('setup persists project.node_id from projectView so board reflection can run', async () => {
    const { client } = createFakeGhClient({
      values: { projectFieldList: STATUS_FIELD_LIST, projectView: { id: 'PVT_node1' } },
    });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.project.node_id).toBe('PVT_node1');
    }
  });

  // Best-effort (ADR-0018): projectView degraded → config still produced WITHOUT node_id
  // (board reflection later skips with a notice; setup itself does not fail).
  test('setup without a resolvable node_id still produces a valid config (graceful)', async () => {
    const { client } = createFakeGhClient({
      values: { projectFieldList: STATUS_FIELD_LIST }, // no projectView value → undefined
    });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.project.node_id).toBeUndefined();
    }
  });

  test('access/permission failure -> clear reason, never crashes (ADR-0018)', async () => {
    const { client } = createFakeGhClient({
      degrade: { ok: false, reason: 'insufficient_perm', detail: 'HTTP 403' },
    });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('insufficient_perm');
      expect(outcome.detail).toContain('403');
    }
  });

  test('unparseable project ref -> invalid_project reason (no gh call)', async () => {
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: STATUS_FIELD_LIST },
    });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'not-a-ref',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid_project');
    expect(calls.length).toBe(0);
  });

  test('flag status-map drops non-done/abandoned keys (notice), keeps done/abandoned', async () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
    const outcome = await buildGithubConfig(fakeIO([]), client, {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done,in_progress=opt_inprog',
      autoReflect: false,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.status_map).toEqual({ done: 'opt_done' });
      expect(outcome.notices.join(' ')).toContain('in_progress');
    }
  });
});
