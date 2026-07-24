import { defineCommand } from 'citty';

import { FAR_FIELD_TAXONOMY_FLOOR, farFieldLenses } from '../../coverage/taxonomy';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto coverage lenses` — print the far-field pre-mortem taxonomy FLOOR: the
 * probing-question lens the coverage sweep answers for each category (ADR-0023 ·
 * ADR-20260625). A pure read of the code default (`FAR_FIELD_TAXONOMY_FLOOR` +
 * `farFieldLenses`); no filesystem, no store, no user-supplied state.
 *
 * This is the ONLY coverage verb the rebuild can honestly back today. The old
 * `ditto coverage` surface (feedback / residual / propose / suggest / list / add /
 * disable / reroute / discover) all rode on a persistent taxonomy override store,
 * a cross-wi feedback ledger, a per-wi coverage-map store, and a discovery gate —
 * none of which the rebuilt `rebuild/coverage/` engine carries yet. Exposing any
 * of them would mean fabricating a backing store, so they are intentionally
 * omitted until their engines are rebuilt.
 */
const coverageLensesCommand = defineCommand({
  meta: {
    name: 'lenses',
    description: 'Print the far-field pre-mortem taxonomy floor (each category id + probing-question lens)',
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
    if (format === 'json') {
      writeJson({
        categories: FAR_FIELD_TAXONOMY_FLOOR.map((c) => ({ id: c.id, lens: c.lens })),
        lenses: farFieldLenses(),
      });
    } else {
      writeHuman(`far-field taxonomy floor: ${FAR_FIELD_TAXONOMY_FLOOR.length} categories`);
      for (const c of FAR_FIELD_TAXONOMY_FLOOR) {
        writeHuman(`  ${c.id}`);
        writeHuman(`    ${c.lens}`);
      }
    }
  },
});

export const coverageCommand = defineCommand({
  meta: {
    name: 'coverage',
    description: 'Far-field pre-mortem coverage — print the taxonomy floor (lenses)',
  },
  subCommands: {
    lenses: coverageLensesCommand,
  },
});
