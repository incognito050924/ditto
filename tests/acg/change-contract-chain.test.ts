import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileIcl } from '~/acg/icl';
import { ChangeContractStore } from '~/core/change-contract-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { preToolUseHandler } from '~/hooks/pre-tool-use';

/**
 * 전 사슬 e2e — ICL 생성 → ChangeContract 저장 → PreToolUse 집행.
 * change-contract CLI의 핵심(compileIcl→ChangeContractStore.write)을 직접 돌려,
 * forbid에 적은 glob이 실제 편집 차단으로 이어지는지 확인한다(CLI는 이 로직의 얇은 래퍼).
 */
const ICL = `intent "scope enforcement e2e" {
  purpose: "forbidden_scope 집행 전 사슬 검증"
  allow {
    glob "src/free/**"
  }
  forbid {
    glob "src/locked/**"
  }
  accept {
    "편집 차단이 동작한다" by test
  }
  meta {
    risk: low
  }
}`;

describe('change-contract → store → PreToolUse (전 사슬)', () => {
  test('ICL forbid(glob)가 편집 차단으로 이어진다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-ccchain-'));
    try {
      const result = compileIcl(ICL, {
        work_item_id: 'wi_ccchain0001',
        produced_by: 'agent',
        produced_at: '2026-06-05T00:00:00Z',
        judge_model_version: 'unspecified',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changeContract.forbidden_scope).toEqual([
        { kind: 'glob', ref: 'src/locked/**' },
      ]);

      await new ChangeContractStore(dir).write('wi_ccchain0001', result.changeContract);
      await new SessionPointerStore(dir).set('sess-chain', 'wi_ccchain0001');

      const edit = (rel: string) =>
        preToolUseHandler({
          raw: {
            tool_name: 'Edit',
            tool_input: { file_path: join(dir, rel) },
            session_id: 'sess-chain',
          },
          repoRoot: dir,
          env: {},
        });

      expect((await edit('src/locked/x.ts')).exitCode).toBe(2); // forbid → 차단
      expect((await edit('src/free/y.ts')).exitCode).toBe(0); // 그 외 → 허용
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
