import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseAdrStatusLine, readAdrStatusAtHead } from './knowledge-bridge';

/**
 * ADR status-at-HEAD tests (wi_2607222uc n-impl-stop-resolution, ac-1).
 *
 * WHY these tests exist (red-first):
 *  - `parseAdrStatusLine` is the SINGLE bilingual status-line parser shared by the
 *    knowledge projection (`adrHeadline`) and the decision-conflict resolution
 *    verification — projection and gate must agree. It must be LINE-anchored
 *    (`- 상태:` / `- status:` list line), never a whole-body substring match:
 *    accepted ADR bodies legitimately contain the word 'superseded' in prose, and a
 *    substring match would fake a supersede verdict. It also extracts the successor
 *    id after 'superseded by' so a false superseded_by claim can be cross-checked.
 *  - `readAdrStatusAtHead` reads the ADR body AT THE HEAD COMMIT (git show), not
 *    the working tree — an uncommitted local edit must NEVER count as landed
 *    positive evidence. Lookup is by id (direct filename for new-form ids, prefix
 *    glob `ADR-NNNN-*` for legacy ids); MULTIPLE matches fail closed (never
 *    pick-first), and EVERY throw (no git, unborn HEAD, missing repo) is contained
 *    and mapped to 'absent' — a throw escaping to the hook runtime would exit 0,
 *    i.e. fail OPEN, which is forbidden.
 */

const roots: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ditto-adr-status-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr?.toString()}`);
  }
}

/** A throwaway git repo with a configured identity and one initial commit. */
function makeRepo(): string {
  const dir = newDir();
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function writeAdrFile(root: string, filename: string, body: string): string {
  const rel = join('.ditto', 'knowledge', 'adr', filename);
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return rel;
}

function commitAdrFile(root: string, filename: string, body: string): void {
  const rel = writeAdrFile(root, filename, body);
  git(root, ['add', rel]);
  git(root, ['commit', '-m', `adr ${filename}`]);
}

const SUPERSEDED_BODY = [
  '# ADR-20260701-old-decision: fixture',
  '',
  '- 상태: superseded by ADR-20260710-new-decision',
  '- 결정 일자: 2026-07-01',
  '',
  '본문.',
  '',
].join('\n');

const ACCEPTED_BODY_WITH_PROSE_SUPERSEDED = [
  '# ADR-20260702-live-decision: fixture',
  '',
  '- 상태: accepted',
  '- 결정 일자: 2026-07-02',
  '',
  '이 결정은 다른 ADR을 superseded 상태로 만들었다 — prose 속 superseded는 상태가 아니다.',
  '',
].join('\n');

describe('parseAdrStatusLine — line-anchored bilingual status parse', () => {
  test('parses `- 상태: accepted` (no successor)', () => {
    const parsed = parseAdrStatusLine(ACCEPTED_BODY_WITH_PROSE_SUPERSEDED);
    expect(parsed?.status).toBe('accepted');
    expect(parsed?.supersededBy).toBeUndefined();
  });

  test('parses `- 상태: superseded by <id>` and extracts the successor id', () => {
    const parsed = parseAdrStatusLine(SUPERSEDED_BODY);
    expect(parsed?.status.startsWith('superseded')).toBe(true);
    expect(parsed?.supersededBy).toBe('ADR-20260710-new-decision');
  });

  test('successor extraction survives trailing annotation and legacy ids', () => {
    const parsed = parseAdrStatusLine('- 상태: superseded by ADR-0016 (2026-07-22 결정)\n');
    expect(parsed?.supersededBy).toBe('ADR-0016');
  });

  test('english `- Status:` list line is a case-insensitive fallback', () => {
    const parsed = parseAdrStatusLine('# t\n\n- Status: Superseded by ADR-20260710-new-decision\n');
    expect(parsed?.status.toLowerCase().startsWith('superseded')).toBe(true);
    expect(parsed?.supersededBy).toBe('ADR-20260710-new-decision');
  });

  test('`상태:` wins over `status:` when both are present', () => {
    const parsed = parseAdrStatusLine('- status: superseded by ADR-0016\n- 상태: accepted\n');
    expect(parsed?.status).toBe('accepted');
  });

  test('prose containing the word superseded does NOT fake a supersede (line-anchored)', () => {
    const parsed = parseAdrStatusLine(ACCEPTED_BODY_WITH_PROSE_SUPERSEDED);
    expect(parsed?.status.startsWith('superseded')).toBe(false);
  });

  test('a body without any status list line parses to null (malformed)', () => {
    expect(parseAdrStatusLine('# title\n\nno status here, 상태 언급만 prose 중간에.\n')).toBeNull();
    expect(parseAdrStatusLine('')).toBeNull();
  });
});

describe('readAdrStatusAtHead — positive evidence from the HEAD commit only', () => {
  test('committed superseded ADR (new-form id, direct filename) → ok + successor', () => {
    const repo = makeRepo();
    commitAdrFile(repo, 'ADR-20260701-old-decision.md', SUPERSEDED_BODY);
    const read = readAdrStatusAtHead(repo, 'ADR-20260701-old-decision');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.adr_status.startsWith('superseded')).toBe(true);
      expect(read.superseded_by).toBe('ADR-20260710-new-decision');
    }
  });

  test('committed accepted ADR → ok, not superseded', () => {
    const repo = makeRepo();
    commitAdrFile(repo, 'ADR-20260702-live-decision.md', ACCEPTED_BODY_WITH_PROSE_SUPERSEDED);
    const read = readAdrStatusAtHead(repo, 'ADR-20260702-live-decision');
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.adr_status.startsWith('superseded')).toBe(false);
  });

  test('legacy id resolves via the prefix glob with the trailing hyphen (single match)', () => {
    const repo = makeRepo();
    commitAdrFile(repo, 'ADR-0016-dual-host.md', SUPERSEDED_BODY);
    // A longer number sharing the digits must NOT match ADR-0016 (trailing hyphen).
    commitAdrFile(repo, 'ADR-00160-unrelated.md', ACCEPTED_BODY_WITH_PROSE_SUPERSEDED);
    const read = readAdrStatusAtHead(repo, 'ADR-0016');
    expect(read.status).toBe('ok');
  });

  test('MULTIPLE candidate files for one id fail closed (ambiguous, never pick-first)', () => {
    const repo = makeRepo();
    commitAdrFile(repo, 'ADR-0016-dual-host.md', SUPERSEDED_BODY);
    commitAdrFile(repo, 'ADR-0016-duplicate.md', SUPERSEDED_BODY);
    const read = readAdrStatusAtHead(repo, 'ADR-0016');
    expect(read.status).toBe('ambiguous');
  });

  test('id with no committed file → absent', () => {
    const repo = makeRepo();
    expect(readAdrStatusAtHead(repo, 'ADR-20260799-never-written').status).toBe('absent');
  });

  test('an UNCOMMITTED working-tree ADR is not positive evidence → absent', () => {
    const repo = makeRepo();
    writeAdrFile(repo, 'ADR-20260701-old-decision.md', SUPERSEDED_BODY); // written, NOT committed
    expect(readAdrStatusAtHead(repo, 'ADR-20260701-old-decision').status).toBe('absent');
  });

  test('committed ADR without a status line → malformed', () => {
    const repo = makeRepo();
    commitAdrFile(
      repo,
      'ADR-20260703-no-status.md',
      '# ADR-20260703-no-status: fixture\n\n본문만.\n',
    );
    expect(readAdrStatusAtHead(repo, 'ADR-20260703-no-status').status).toBe('malformed');
  });

  test('non-git directory: every throw is contained → absent (never escapes)', () => {
    const dir = newDir(); // plain directory, no git repo
    expect(readAdrStatusAtHead(dir, 'ADR-20260701-old-decision').status).toBe('absent');
  });

  test('git repo with an unborn HEAD (no commits) → absent (throw contained)', () => {
    const dir = newDir();
    git(dir, ['init', '-b', 'main']);
    expect(readAdrStatusAtHead(dir, 'ADR-20260701-old-decision').status).toBe('absent');
  });
});
