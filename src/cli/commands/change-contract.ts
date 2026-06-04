import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { compileIcl } from '~/acg/icl';
import { expandForbiddenSymbols } from '~/acg/scope/symbol-expand';
import { ChangeContractStore } from '~/core/change-contract-store';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
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

    // symbol kind forbidden_scope를 선언 파일 path로 펴서 PreToolUse가 집행할 수 있게 한다
    // (저장 시점 1회 CodeQL; symbol이 없으면 미호출).
    const expanded = await expandForbiddenSymbols(result.changeContract, {
      repoRoot,
      sourceRoot: join(repoRoot, 'src'),
      language: 'javascript',
      cacheDir: codeqlCacheDir(repoRoot, 'javascript'),
      deps: makeRelationDeps(),
    });
    await new ChangeContractStore(repoRoot).write(args['work-item'], expanded.contract);

    const summary = {
      work_item_id: args['work-item'],
      forbidden_scope: expanded.contract.forbidden_scope.length,
      allowed_scope: expanded.contract.allowed_scope.length,
      fitness_functions: result.fitnessFunctions.length,
      symbols_resolved: expanded.resolved,
      symbols_unresolved: expanded.unresolved,
      warnings: result.warnings?.length ?? 0,
    };
    if (format === 'json') {
      writeJson(summary);
    } else {
      const unresolvedNote =
        summary.symbols_unresolved.length > 0
          ? `, unresolved symbols [${summary.symbols_unresolved.join(', ')}]`
          : '';
      writeHuman(
        `change-contract: saved → .ditto/work-items/${args['work-item']}/change-contract.json ` +
          `(forbidden ${summary.forbidden_scope}, allowed ${summary.allowed_scope}, ` +
          `fitness ${summary.fitness_functions}, symbols→path ${summary.symbols_resolved}${unresolvedNote}, ` +
          `warnings ${summary.warnings})`,
      );
    }
  },
});
