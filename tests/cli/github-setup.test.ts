import { describe, expect, test } from 'bun:test';
import {
  type GithubSetupOptions,
  buildGithubConfig,
  extractStatusOptions,
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

    const interactive = await buildGithubConfig(
      fakeIO(['incognito050924/5', '4', '5', '']),
      client,
      { nonInteractive: false },
    );

    const flags: GithubSetupOptions = {
      nonInteractive: true,
      project: 'incognito050924/5',
      statusMap: 'done=opt_done,abandoned=opt_dropped',
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
        auto_reflect: false,
      });
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
