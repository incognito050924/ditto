import { defineCommand } from 'citty';
import { render, renderMermaid, summarize } from '~/acg/change-map';
import { AcgReviewStore } from '~/core/acg-review-store';
import { ChangeContractStore } from '~/core/change-contract-store';
import { localDir } from '~/core/ditto-paths';
import { readJson, resolveRepoRootForCreate } from '~/core/fs';
import { type AcgImpactGraph, acgImpactGraph } from '~/schemas/acg-impact-graph';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto change-map` — Change Map 텍스트 정본 렌더러.
 *
 * read-only producer. `.ditto/local/work-items/<wi>/`의 change-contract.json(필수)·
 * impact-graph.json(선택)·acg-review.json(선택)을 읽어 §2.1 텍스트(human) 또는
 * 요약(json)을 낸다. change-contract.json 부재면 USAGE_ERROR로 종료한다.
 */
export const changeMapCommand = defineCommand({
  meta: {
    name: 'change-map',
    description: 'Render the Change Map text notation for a work item',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    output: {
      type: 'string',
      description: 'Output format: human|json|mermaid',
      default: 'human',
    },
  },
  run: async ({ args }) => {
    // mermaid는 텍스트 정본의 파생 다이어그램(§3) — human/json과 별도 분기.
    const isMermaid = args.output === 'mermaid';
    let format: ReturnType<typeof parseOutputFormat> = 'human';
    if (!isMermaid) {
      try {
        format = parseOutputFormat(args.output);
      } catch (err) {
        writeError(err instanceof Error ? err.message : String(err));
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }

    const repoRoot = await resolveRepoRootForCreate();
    const workItem = args['work-item'];

    const contract = await new ChangeContractStore(repoRoot).read(workItem);
    if (!contract) {
      writeError(`change-map: change-contract.json not found for ${workItem}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    // impact-graph.json·acg-review.json은 선택 — 부재/위반이면 무시(read-only).
    let impact: AcgImpactGraph | undefined;
    try {
      impact = await readJson(
        localDir(repoRoot, 'work-items', workItem, 'impact-graph.json'),
        acgImpactGraph,
      );
    } catch {
      impact = undefined;
    }

    const reviewStore = new AcgReviewStore(repoRoot);
    const review = (await reviewStore.exists(workItem))
      ? await reviewStore.get(workItem)
      : undefined;

    if (isMermaid) {
      writeHuman(renderMermaid(contract, impact, review));
    } else if (format === 'json') {
      writeJson(summarize(contract, impact, review));
    } else {
      writeHuman(render(contract, impact, review));
    }
  },
});
