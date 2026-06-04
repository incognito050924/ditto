/**
 * ChangeContractStore — work item별 ChangeContract를 per-entity 파일로 저장한다
 * (ADR-0005 저장 정책). `.ditto/work-items/<wi>/change-contract.json`.
 *
 * forbidden_scope 집행(PreToolUse)이 현재 work item의 계약을 읽는 진실원이다. ICL
 * 컴파일러(src/acg/icl/compile.ts)의 산출물이 이 store로 저장되어야 게이트가 집행할 수 있다.
 */
import { join } from 'node:path';
import { ensureDir, readJson, writeJson } from '~/core/fs';
import { type AcgChangeContract, acgChangeContract } from '~/schemas/acg-change-contract';

export class ChangeContractStore {
  constructor(private readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'change-contract.json');
  }

  /** 계약을 읽는다. 파일 부재 또는 스키마 위반이면 null(집행은 fail-open). */
  async read(workItemId: string): Promise<AcgChangeContract | null> {
    try {
      return await readJson(this.path(workItemId), acgChangeContract);
    } catch {
      return null;
    }
  }

  /** 계약을 저장한다(스키마 검증). */
  async write(workItemId: string, contract: AcgChangeContract): Promise<void> {
    await ensureDir(this.dir(workItemId));
    await writeJson(this.path(workItemId), acgChangeContract, contract);
  }
}
