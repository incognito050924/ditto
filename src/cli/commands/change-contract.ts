import { readFile } from 'node:fs/promises';
import { defineCommand } from 'citty';
import { compileIcl } from '~/acg/icl';
import { ChangeContractStore } from '~/core/change-contract-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto change-contract` — ICL(.icl)을 ChangeContract로 컴파일해 저장한다.
 *
 * forbidden_scope 집행(pre-tool-use.ts)이 읽는 진실원
 * `.ditto/work-items/<wi>/change-contract.json`을 만드는 생성 경로다. 이게 있어야
 * "ICL 생성 → 계약 저장 → PreToolUse 집행"의 전 사슬이 돈다. fitnessFunctions는 개수만
 * 보고하고 저장하지 않는다(별도 store는 후속).
 */
export const changeContractCommand = defineCommand({
  meta: {
    name: 'change-contract',
    description:
      'Compile an ICL file into a ChangeContract and store it (단계1, forbidden_scope 집행 입력)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    file: { type: 'string', description: 'Path to the .icl source', required: true },
    'judge-model': {
      type: 'string',
      description: 'judge_model_version for llm_judged fitness (default: unspecified)',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    let source: string;
    try {
      source = await readFile(args.file, 'utf8');
    } catch {
      writeError(`change-contract: cannot read ICL file ${args.file}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    const result = compileIcl(source, {
      work_item_id: args['work-item'],
      produced_by: 'agent',
      produced_at: new Date().toISOString(),
      judge_model_version: args['judge-model'] ?? 'unspecified',
    });

    if (!result.ok) {
      if (format === 'json') {
        writeJson({ ok: false, errors: result.errors });
      } else {
        writeError(`change-contract: ICL 컴파일 실패 (${result.errors.length} error)`);
        for (const e of result.errors) {
          const where = e.kind === 'parse' && e.line ? ` (line ${e.line})` : '';
          writeError(`  - [${e.kind}] ${e.message}${where}`);
        }
      }
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }

    const repoRoot = await resolveRepoRootForCreate();
    await new ChangeContractStore(repoRoot).write(args['work-item'], result.changeContract);

    const summary = {
      work_item_id: args['work-item'],
      forbidden_scope: result.changeContract.forbidden_scope.length,
      allowed_scope: result.changeContract.allowed_scope.length,
      fitness_functions: result.fitnessFunctions.length,
      warnings: result.warnings?.length ?? 0,
    };
    if (format === 'json') {
      writeJson(summary);
    } else {
      writeHuman(
        `change-contract: saved → .ditto/work-items/${args['work-item']}/change-contract.json ` +
          `(forbidden ${summary.forbidden_scope}, allowed ${summary.allowed_scope}, ` +
          `fitness ${summary.fitness_functions}, warnings ${summary.warnings})`,
      );
    }
  },
});
