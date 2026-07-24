import { defineCommand } from 'citty';

import { formatCoord, parseCoord } from '../../github/coord';
import { getLinkedCoord, linkIssue } from '../../github/linkage';
import { loadWorkItem } from '../../record/store';
import { findRepoRoot } from '../../util/fs';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto github` — the issue↔work-item linkage surface (SoT layer 2). Only the
 * linkage layer is fronted here: it is the one github module the rebuilt engine
 * backs with a REAL implementation (pure local Record state via the record
 * store). The backlog READ (layer 1) and completion MIRROR (layer 3) both need
 * an injected `gh` port (`BacklogReader` / `MirrorWriter`) that has no real
 * construction in rebuild/ yet, so those verbs are deliberately absent — a CLI
 * verb over an un-constructable port would be a dead surface.
 */

/**
 * `ditto github link <work-item> <owner/repo#n>` — bind a GitHub issue
 * coordinate onto a work item's Record. Idempotent (re-linking the same
 * coordinate rewrites the same value). Thin surface over `linkIssue`; the
 * coordinate is validated by the engine's `parseCoord`.
 */
const linkCommand = defineCommand({
  meta: {
    name: 'link',
    description: 'Bind a GitHub issue coordinate (owner/repo#n) onto a work item Record',
  },
  args: {
    'work-item': { type: 'positional', description: 'Work item id' },
    coord: { type: 'positional', description: 'Issue coordinate — owner/repo#n' },
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
    const coord = parseCoord(args.coord);
    if (coord === null) {
      writeError(`invalid coordinate "${args.coord}"; expected owner/repo#n`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const repoRoot = await findRepoRoot();
    let record: Awaited<ReturnType<typeof linkIssue>>;
    try {
      record = await linkIssue(repoRoot, args['work-item'], { repo: coord.repo, number: coord.number });
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(RUNTIME_ERROR_EXIT);
    }
    if (format === 'json') {
      writeJson({ work_item_id: record.id, github: record.github ?? null });
    } else {
      writeHuman(`github link: ${record.id} → ${formatCoord(coord)}`);
    }
  },
});

/**
 * `ditto github linked <work-item>` — recover a work item's linked `owner/repo#n`
 * coordinate, or report that it is unlinked. Read-only; thin surface over
 * `getLinkedCoord` folded over the record store's view.
 */
const linkedCommand = defineCommand({
  meta: {
    name: 'linked',
    description: 'Show the GitHub issue coordinate linked to a work item, if any',
  },
  args: {
    'work-item': { type: 'positional', description: 'Work item id' },
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
    let loaded: Awaited<ReturnType<typeof loadWorkItem>>;
    try {
      loaded = await loadWorkItem(repoRoot, args['work-item']);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(RUNTIME_ERROR_EXIT);
    }
    const coord = getLinkedCoord(loaded.view);
    if (format === 'json') {
      writeJson({ work_item_id: loaded.view.id, coord: coord ? formatCoord(coord) : null });
    } else if (coord === null) {
      writeHuman(`github linked: ${loaded.view.id} — no linked GitHub issue.`);
    } else {
      writeHuman(`github linked: ${loaded.view.id} → ${formatCoord(coord)}`);
    }
  },
});

export const githubCommand = defineCommand({
  meta: {
    name: 'github',
    description: 'GitHub issue↔work-item linkage (SoT layer 2) — link, linked',
  },
  subCommands: {
    link: linkCommand,
    linked: linkedCommand,
  },
});
