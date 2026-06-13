import { writeFile } from 'node:fs/promises';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, findRepoRoot } from '~/core/fs';
// Importing the hosts barrel registers the codex + claude-code adapters.
import { listHostAdapters } from '~/core/hosts';
import { generateSurfaceCatalog } from '~/core/surface-inventory';

/**
 * Regenerate the per-host surface catalogs from the code (G6). Each catalog is a
 * build artifact, not a hand-maintained file: run this after adding/removing a
 * skill, agent, command, plugin, or hook. CI regenerates and compares (see
 * tests/doctor/surface.test.ts) so a stale catalog fails loudly.
 *
 * claude-code -> `.ditto/local/surfaces.json` (canonical), codex ->
 * `.ditto/local/surfaces.codex.json`. The generator filters by catalog file, so
 * each host's surfaces only ever land in its own catalog.
 */
async function writeCatalog(repoRoot: string, catalogFile: string): Promise<void> {
  const catalog = await generateSurfaceCatalog(listHostAdapters(), repoRoot, catalogFile);
  const out = localDir(repoRoot, catalogFile);
  // One surface per line keeps the generated catalog reviewable in diffs.
  const body = catalog.surfaces
    .map(
      (s) =>
        `    { "host": ${JSON.stringify(s.host)}, "kind": ${JSON.stringify(s.kind)}, "id": ${JSON.stringify(s.id)}, "path": ${JSON.stringify(s.path)} }`,
    )
    .join(',\n');
  const text = `{\n  "schema_version": ${JSON.stringify(catalog.schema_version)},\n  "surfaces": [\n${body}\n  ]\n}\n`;
  await writeFile(out, text, 'utf8');
  console.log(`wrote ${catalog.surfaces.length} surfaces → ${out}`);
}

async function main(): Promise<void> {
  const repoRoot = await findRepoRoot();
  await ensureDir(localDir(repoRoot));
  await writeCatalog(repoRoot, 'surfaces.json');
  await writeCatalog(repoRoot, 'surfaces.codex.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
