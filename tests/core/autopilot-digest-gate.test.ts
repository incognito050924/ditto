import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextNode } from '~/core/autopilot-loop';
import { finalizeTechSpec, finalizeTechSpecPayload, startTechSpec } from '~/core/tech-spec';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * ac-6: finalize 이후 digest 범위(컴파일 입력 섹션)에 포함된 섹션이 수정되면
 * 불일치가 감지되어 autopilot 실행이 차단되고 재-finalize가 요구된다.
 */

const DOC_PATH = '.ditto/specs/demo.md';

function specDoc(goals = '- 점수 API 제공'): string {
  return `# 데모 — 테크스펙

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
  await startTechSpec(repo, { workItemId: wiId, docPath: DOC_PATH });
  const res = await finalizeTechSpec(repo, {
    workItemId: wiId,
    payload: finalizeTechSpecPayload.parse({
      user_confirmation: { confirmed: true, statement: '의도 일치 확인' },
    }),
  });
  if (res.status !== 'finalized') throw new Error(`fixture finalize failed: ${res.status}`);
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
      expect(res.reason).toContain('tech-spec finalize');
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
    const res = await finalizeTechSpec(repo, {
      workItemId: wiId,
      payload: finalizeTechSpecPayload.parse({
        user_confirmation: { confirmed: true, statement: '변경 반영 확인' },
      }),
    });
    expect(res.status).toBe('finalized');
    expect((await nextNode(repo, wiId)).action).not.toBe('blocked');
  });
});
