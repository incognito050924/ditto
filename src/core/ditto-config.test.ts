import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DittoConfigHandoffPushConsent,
  readGithubConfig,
  readHandoffPushConsent,
  writeGithubConfig,
  writeHandoffPushConsent,
} from './ditto-config';

/**
 * Handoff write-push consent — reader/writer tests (wi_2607239vu, ac-3·C5).
 *
 * WHY these tests exist (red-first). The consent is a standing per-project grant
 * that lets `handoff write` auto-push a new body to a public/unknown remote; its
 * whole safety rests on four properties the assertions pin:
 *  - STORE LOCATION (ac-3 core): consent is read/written ONLY through the single
 *    per-developer store at `.ditto/local/config.json` (via localDir) — never a
 *    parallel consent-specific file. A test drives the reader/writer against a temp
 *    repoRoot and asserts the bytes land at exactly that path and nowhere else.
 *  - ORIGIN BINDING: the grant is pinned to the exact origin URL. Keying by repo
 *    path would carry the grant over on origin re-point/transfer/fork. A mismatched
 *    current origin MUST read back as "no consent" (carry-over blocked).
 *  - GRANT LIFECYCLE + FAIL-CLOSED: before recording, a lookup is denied
 *    (undefined); after recording for the matching origin, it is granted and exposes
 *    `visibility_at_grant`. A malformed stored value (string/number/object/truthy
 *    'false') MUST fail closed to denial — a truthy mis-read is forbidden.
 *  - SIBLING PRESERVATION (C5): the writer does temp+rename atomic writes and
 *    raw-spreads existing blocks, so a prior github/deep_interview block survives
 *    (no silent sibling erasure — wi_260707oi1).
 */

const roots: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ditto-config-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const CONFIG_REL = join('.ditto', 'local', 'config.json');

function configPath(root: string): string {
  return join(root, CONFIG_REL);
}

/** Write a raw config.json at the canonical store path (bypassing the writer). */
function seedRawConfig(root: string, body: string): void {
  const path = configPath(root);
  mkdirSync(join(root, '.ditto', 'local'), { recursive: true });
  writeFileSync(path, body);
}

const ORIGIN = 'https://github.com/owner/repo.git';
const OTHER_ORIGIN = 'https://github.com/other/fork.git';

function grant(
  overrides: Partial<DittoConfigHandoffPushConsent> = {},
): DittoConfigHandoffPushConsent {
  return {
    origin_url: ORIGIN,
    visibility_at_grant: 'private',
    granted_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('handoff write-push consent — grant lifecycle', () => {
  test('before recording: lookup denied (undefined)', async () => {
    const root = newRoot();
    expect(await readHandoffPushConsent(root, ORIGIN)).toBeUndefined();
  });

  test('after recording: granted for the matching origin + exposes visibility stamp', async () => {
    const root = newRoot();
    await writeHandoffPushConsent(root, grant({ visibility_at_grant: 'private' }));
    const got = await readHandoffPushConsent(root, ORIGIN);
    expect(got).toBeDefined();
    expect(got?.origin_url).toBe(ORIGIN);
    expect(got?.visibility_at_grant).toBe('private');
    expect(got?.granted_at).toBe('2026-07-23T00:00:00.000Z');
  });
});

describe('handoff write-push consent — origin binding (carry-over blocked)', () => {
  test('consent granted for one origin is NOT honoured for a different current origin', async () => {
    const root = newRoot();
    await writeHandoffPushConsent(root, grant({ origin_url: ORIGIN }));
    // Same repo path, but origin was re-pointed / transferred / forked.
    expect(await readHandoffPushConsent(root, OTHER_ORIGIN)).toBeUndefined();
    // Still valid for the exact origin it was granted to.
    expect(await readHandoffPushConsent(root, ORIGIN)).toBeDefined();
  });
});

describe('handoff write-push consent — store location (ac-3)', () => {
  test('writer lands bytes at exactly .ditto/local/config.json and reader consumes that path', async () => {
    const root = newRoot();
    await writeHandoffPushConsent(root, grant());
    // The single canonical store exists and contains the consent block.
    const onDisk = JSON.parse(readFileSync(configPath(root), 'utf8'));
    expect(onDisk.handoff_push_consent.origin_url).toBe(ORIGIN);
    // Reader consumes THAT store: a hand-written block at the canonical path is read.
    const root2 = newRoot();
    seedRawConfig(root2, `${JSON.stringify({ handoff_push_consent: grant() }, null, 2)}\n`);
    expect(await readHandoffPushConsent(root2, ORIGIN)).toBeDefined();
  });
});

describe('handoff write-push consent — fail-closed on malformed', () => {
  const cases: Array<[string, unknown]> = [
    ['string', 'granted'],
    ["truthy string 'false'", 'false'],
    ['number', 1],
    ['boolean true', true],
    ['partial object (missing origin_url)', { visibility_at_grant: 'public', granted_at: 'x' }],
    [
      'object with wrong-typed origin_url',
      { origin_url: 5, visibility_at_grant: 'public', granted_at: 'x' },
    ],
    [
      'invalid visibility enum',
      { origin_url: ORIGIN, visibility_at_grant: 'secret', granted_at: 'x' },
    ],
  ];
  for (const [label, value] of cases) {
    test(`malformed consent value (${label}) → denied`, async () => {
      const root = newRoot();
      seedRawConfig(root, `${JSON.stringify({ handoff_push_consent: value }, null, 2)}\n`);
      expect(await readHandoffPushConsent(root, ORIGIN)).toBeUndefined();
    });
  }

  test('malformed JSON file → denied (never throws)', async () => {
    const root = newRoot();
    seedRawConfig(root, '{ this is not json');
    expect(await readHandoffPushConsent(root, ORIGIN)).toBeUndefined();
  });
});

describe('handoff write-push consent — sibling preservation (C5)', () => {
  test('writing consent preserves an existing github block', async () => {
    const root = newRoot();
    await writeGithubConfig(root, {
      project: { owner: 'acme', number: 7 },
      status_map: { done: 'DONE_ID' },
      auto_reflect: false,
    });
    await writeHandoffPushConsent(root, grant());
    // Both blocks coexist in the single store.
    const github = await readGithubConfig(root);
    expect(github?.project.owner).toBe('acme');
    expect(await readHandoffPushConsent(root, ORIGIN)).toBeDefined();
    const onDisk = JSON.parse(readFileSync(configPath(root), 'utf8'));
    expect(onDisk.github).toBeDefined();
    expect(onDisk.handoff_push_consent).toBeDefined();
  });

  test('writing consent preserves an unknown legacy sibling block (raw-spread)', async () => {
    const root = newRoot();
    // A schema-valid file (github known-valid) that also carries an unknown block.
    seedRawConfig(
      root,
      `${JSON.stringify(
        {
          github: { project: { owner: 'acme', number: 7 }, status_map: {}, auto_reflect: false },
          legacy_block: { keep: 'me' },
        },
        null,
        2,
      )}\n`,
    );
    await writeHandoffPushConsent(root, grant());
    const onDisk = JSON.parse(readFileSync(configPath(root), 'utf8'));
    expect(onDisk.legacy_block).toEqual({ keep: 'me' });
    expect(onDisk.github).toBeDefined();
    expect(onDisk.handoff_push_consent).toBeDefined();
  });
});
