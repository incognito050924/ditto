import { writeFile } from 'node:fs/promises';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, findRepoRoot } from '~/core/fs';
// Importing the hosts barrel registers the codex + claude-code adapters.
import { listHostAdapters } from '~/core/hosts';
import { generateSurfaceCatalog } from '~/core/surface-inventory';

/**
 * Regenerate `.ditto/local/surfaces.json` from the code (G6). The catalog is a build
 * artifact, not a hand-maintained file: run this after adding/removing a skill,
 * agent, command, plugin, or hook. CI regenerates and compares (see
 * tests/doctor/surface.test.ts) so a stale catalog fails loudly.
 */
async function main(): Promise<void> {
  const repoRoot = await findRepoRoot();
  const catalog = await generateSurfaceCatalog(listHostAdapters(), repoRoot);
  const out = localDir(repoRoot, 'surfaces.json');
  await ensureDir(localDir(repoRoot));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
