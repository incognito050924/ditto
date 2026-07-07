import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { nextNode } from '~/core/autopilot-loop';
import { IntentStore } from '~/core/intent-store';
import { compileSpecDoc } from '~/core/spec-doc';
import { WorkItemStore } from '~/core/work-item-store';
import type { IntentContract } from '~/schemas/intent';

/**
 * ac-6: after finalize, if a section inside the digest range (the compile-input
 * sections) is edited, the mismatch is detected, autopilot execution is blocked,
 * and re-finalize is required. The digest freshness gate is surface-agnostic — it
 * reuses the preserved spec-doc compiler; the fixture stamps intent.source_digest
 * directly (no removed tech-spec surface).
 */

const DOC_PATH = '.ditto/specs/demo.md';

function specDoc(goals = '- 점수 API 제공'): string {
  return `# 데모 — 스펙 문서

## 2. 요약

비밀번호 강도 점수 API를 추가한다.

## 4. 목표

${goals}

## 5. 비목표 (변경 경계) [장]

- 비밀번호 정책 변경은 하지 않는다

## 6. 완료 조건 (Acceptance Criteria)

| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200과 score 0-100을 반환한다 | test |

## 7. 위험 / Pre-mortem

| 위험 | 처리 | 플래그 |
|---|---|---|

## 8. 계획 (Plan) [단]

> ⚠ 비구속(non-binding) 설계 힌트.

엔드포인트 모양 힌트.
`;
}

let repo: string;
let wiId: string;

async function writeDoc(content: string): Promise<void> {
  await mkdir(join(repo, '.ditto', 'specs'), { recursive: true });
  await writeFile(join(repo, DOC_PATH), content, 'utf8');
}

/**
 * Compile the spec doc, write intent.json with source_digest, mirror AC into the
 * work item, and bootstrap autopilot — the finalize essentials, minus the retired
 * tech-spec state machine. Returns the finalize disposition string for assertions.
 */
async function finalizeFixture(): Promise<'finalized'> {
  const doc = await Bun.file(join(repo, DOC_PATH)).text();
  const compiled = compileSpecDoc(doc);
  if (compiled.status !== 'compiled')
    throw new Error(`fixture compile failed: ${compiled.reasons.join('; ')}`);
  const items = new WorkItemStore(repo);
  const workItem = await items.get(wiId);
  const intent: IntentContract = {
    schema_version: '0.1.0',
    work_item_id: wiId,
    source_request: workItem.source_request,
    goal: compiled.fields.goal,
    in_scope: compiled.fields.in_scope,
    out_of_scope: compiled.fields.out_of_scope,
    acceptance_criteria: compiled.fields.acceptance_criteria,
    unknowns: compiled.fields.unknowns,
    follow_up_candidates: [],
    question_policy: 'ask_only_if_user_only_can_answer',
    source_digest: { doc_path: DOC_PATH, sha256: compiled.digest },
  };
  const writtenIntent = await new IntentStore(repo).write(intent);
  await items.update(wiId, (current) => ({
    ...current,
    acceptance_criteria: compiled.fields.acceptance_criteria.map((ac) => ({
      id: ac.id,
      statement: ac.statement,
      verdict: ac.verdict,
      evidence: ac.evidence,
    })),
    goal: compiled.fields.goal,
  }));
  const boot = await bootstrapAutopilot(repo, {
    workItem: await items.get(wiId),
    intent: writtenIntent,
    risk: { non_local: false, irreversible: false, unaudited: false },
  });
  if (boot.status !== 'created') throw new Error(`fixture bootstrap failed: ${boot.status}`);
  return 'finalized';
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-dg-'));
  const wi = await new WorkItemStore(repo).create({
    title: 'password strength endpoint',
    source_request: 'add a /password-strength endpoint',
    goal: 'returns a 0-100 score for a password',
    acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
  await writeDoc(specDoc());
  expect(await finalizeFixture()).toBe('finalized');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('autopilot digest freshness gate (ac-6)', () => {
  test('fresh doc → loop proceeds (not blocked by the gate)', async () => {
    const res = await nextNode(repo, wiId);
    expect(res.action).not.toBe('blocked');
  });

  test('compile-input section edited after finalize → blocked, re-finalize required', async () => {
    await writeDoc(specDoc('- 완전히 다른 목표'));
    const res = await nextNode(repo, wiId);
    expect(res.action).toBe('blocked');
    if (res.action === 'blocked') {
      expect(res.reason).toContain('deep-interview finalize');
    }
  });

  test('non-compile-input section edited → not blocked (digest 범위 밖)', async () => {
    await writeDoc(specDoc().replace('엔드포인트 모양 힌트.', '계획 전면 교체.'));
    const res = await nextNode(repo, wiId);
    expect(res.action).not.toBe('blocked');
  });

  test('spec doc deleted → blocked (fail-closed)', async () => {
    await unlink(join(repo, DOC_PATH));
    const res = await nextNode(repo, wiId);
    expect(res.action).toBe('blocked');
  });

  test('re-finalize after the edit unblocks the loop', async () => {
    await writeDoc(specDoc('- 완전히 다른 목표'));
    expect((await nextNode(repo, wiId)).action).toBe('blocked');
    expect(await finalizeFixture()).toBe('finalized');
    expect((await nextNode(repo, wiId)).action).not.toBe('blocked');
  });
});
