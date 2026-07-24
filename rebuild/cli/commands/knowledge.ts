import { defineCommand } from 'citty';

import { checkAdrConsistency } from '../../knowledge/adr-check';
import { findRepoRoot } from '../../util/fs';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto knowledge adr-check` — fail-closed consistency check over
 * `.ditto/knowledge/adr/` (filename format + identifier uniqueness). Read-only;
 * a thin surface over `checkAdrConsistency`. Exits non-zero when violations are
 * found so a caller (pre-commit, CI) can gate on it.
 */
const adrCheckCommand = defineCommand({
  meta: {
    name: 'adr-check',
    description: 'Check ADR filename format + identifier uniqueness under .ditto/knowledge/adr/',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const repoRoot = await findRepoRoot();
    const result = await checkAdrConsistency(repoRoot);
    if (format === 'json') {
      writeJson(result);
    } else if (result.ok) {
      writeHuman('adr-check: OK — no violations.');
    } else {
      writeHuman(`adr-check: ${result.violations.length} violation(s)`);
      for (const v of result.violations) writeHuman(`  - ${v}`);
    }
    if (!result.ok) process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const knowledgeCommand = defineCommand({
  meta: {
    name: 'knowledge',
    description: 'Durable project knowledge — ADR consistency (adr-check)',
  },
  subCommands: {
    'adr-check': adrCheckCommand,
  },
});
