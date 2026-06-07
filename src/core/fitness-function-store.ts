/**
 * FitnessFunctionStore — work item별 fitness function 집합을 per-entity 파일로 저장한다
 * (ADR-0005). `.ditto/local/work-items/<wi>/fitness-functions.json` (AcgFitnessFunction 배열).
 *
 * ICL 컴파일러가 만든 fitnessFunctions가 여기 저장되어야 `ditto fitness run`이 매번 ICL을
 * 재컴파일하지 않고 읽어서 평가할 수 있다(forbidden_scope의 ChangeContractStore와 대칭).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, readJson, writeJson } from '~/core/fs';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

const fitnessFunctionArray = z.array(acgFitnessFunction);

export class FitnessFunctionStore {
  constructor(private readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'fitness-functions.json');
  }

  /** 저장된 fitness function 배열을 읽는다. 부재 또는 스키마 위반이면 null. */
  async read(workItemId: string): Promise<AcgFitnessFunction[] | null> {
    try {
      return await readJson(this.path(workItemId), fitnessFunctionArray);
    } catch {
      return null;
    }
  }

  /** fitness function 배열을 저장한다(빈 배열도 유효). */
  async write(workItemId: string, functions: AcgFitnessFunction[]): Promise<void> {
    await ensureDir(this.dir(workItemId));
    await writeJson(this.path(workItemId), fitnessFunctionArray, functions);
  }
}
