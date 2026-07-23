import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { ADR_ID_EXTRACT_RE, ADR_TITLE_PREFIX_RE } from '../schemas/adr-id';
import { dittoDir } from '../util/paths';
import { parseAdrStatusLine } from './adr-status';

/**
 * Knowledge summary sources — the upstream data contract of the
 * decision-conflict guardrail: the same `.ditto/knowledge` bodies (glossary
 * index, adr/*.md) feed both this projection and the gate-side status
 * verification, summarized here into headlines only. Bodies stay as path
 * references; promotion judgment (which terms are "agreed") stays with the
 * LLM curator — no heuristic term extraction here.
 */

// Deliberately tolerant summary read: only `entries[].term/status` matter for
// the headline projection; unknown/extra fields never break it. A malformed
// glossary degrades to zero term headlines (the strict `glossary` schema in
// rebuild/schemas/glossary.ts owns authoring-time validation).
const glossarySummarySchema = z.object({
  entries: z.array(z.object({ term: z.string(), status: z.string().optional() })).default([]),
});

export interface KnowledgeSources {
  contextPath: string;
  glossaryPath: string;
  adrDir: string;
  /** Sorted ADR headline summaries (id · status · title). */
  adrHeadlines: string[];
  /** Sorted glossary term headlines. */
  termHeadlines: string[];
}

const KNOWLEDGE_DIR = join('.ditto', 'knowledge');

function adrHeadline(filename: string, body: string): string {
  const id = filename.match(ADR_ID_EXTRACT_RE)?.[0] ?? filename;
  const titleLine = body.split('\n').find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.replace(/^#\s*/, '').trim() : '';
  // Same parser as the gate-side verification (parseAdrStatusLine) so projection
  // and gate agree; the headline keeps only the first token (`superseded`,
  // `accepted (…)` → `accepted`).
  const status = parseAdrStatusLine(body)?.status.split(/\s+/)[0] ?? '';
  const parts = [id];
  if (status) parts.push(status);
  if (title) parts.push(title.replace(ADR_TITLE_PREFIX_RE, ''));
  return parts.join(' · ');
}

/**
 * Read the real `.ditto/knowledge` sources and build the summary inputs.
 * Bodies stay as path references; only headlines are summarized. Every read is
 * fail-open to empty — a missing or malformed source degrades the summary,
 * never crashes the projection (adr-check owns strict validation).
 */
export async function loadKnowledgeSources(repoRoot: string): Promise<KnowledgeSources> {
  const knowledgeDir = join(dittoDir(repoRoot), 'knowledge');
  const contextPath = join(KNOWLEDGE_DIR, 'CONTEXT.md');
  const glossaryPath = join(KNOWLEDGE_DIR, 'glossary.json');
  const adrDir = join(KNOWLEDGE_DIR, 'adr');

  let termHeadlines: string[] = [];
  try {
    const raw: unknown = JSON.parse(await readFile(join(knowledgeDir, 'glossary.json'), 'utf8'));
    const parsed = glossarySummarySchema.safeParse(raw);
    if (parsed.success) {
      termHeadlines = parsed.data.entries
        .map((e) => (e.status && e.status !== 'agreed' ? `${e.term} (${e.status})` : e.term))
        .sort();
    }
  } catch {
    // Missing or malformed glossary — projected as zero terms.
  }

  const adrHeadlines: string[] = [];
  const adrPath = join(knowledgeDir, 'adr');
  let adrEntries: string[] = [];
  try {
    // Deliberately lenient filter (`\d{8}` starts with `\d{4}`, so both forms
    // match): the projection lists what exists; adr-check owns strictness.
    adrEntries = (await readdir(adrPath)).filter((f) => /^ADR-\d{4}.*\.md$/.test(f));
  } catch {
    adrEntries = [];
  }
  for (const rel of adrEntries) {
    const body = await readFile(join(adrPath, rel), 'utf8');
    adrHeadlines.push(adrHeadline(rel, body));
  }
  adrHeadlines.sort();

  return { contextPath, glossaryPath, adrDir, adrHeadlines, termHeadlines };
}

/** Build the summary body (the text inside the managed block). */
export function renderKnowledgeSummary(sources: KnowledgeSources): string {
  const lines: string[] = [];
  lines.push('# DITTO Knowledge (projected — do not edit by hand)');
  lines.push('');
  lines.push(
    'Durable project knowledge. Bodies live under `.ditto/knowledge/`; this is a summary.',
  );
  lines.push('');
  lines.push(`- context: \`${sources.contextPath}\``);
  lines.push(`- glossary: \`${sources.glossaryPath}\``);
  lines.push(`- decisions: \`${sources.adrDir}/\``);
  lines.push('');
  lines.push('## Glossary terms');
  if (sources.termHeadlines.length === 0) lines.push('- (none)');
  for (const t of sources.termHeadlines) lines.push(`- ${t}`);
  lines.push('');
  lines.push('## Architecture decisions');
  if (sources.adrHeadlines.length === 0) lines.push('- (none)');
  for (const a of sources.adrHeadlines) lines.push(`- ${a}`);
  lines.push('');
  return lines.join('\n');
}
