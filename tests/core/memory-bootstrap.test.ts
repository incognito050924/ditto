import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapIngest, searchEventBodies } from '~/core/memory-bootstrap';
import { MemoryEventStore, MemorySourceStore } from '~/core/memory-store';
import { duplicateSearch } from '~/hooks/user-prompt-submit';

let workDir: string;

function initGit(d: string) {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: d, stdout: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: d, stdout: 'pipe' });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: d,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function seedKnowledge(root: string) {
  const adrDir = join(root, '.ditto', 'knowledge', 'adr');
  await mkdir(adrDir, { recursive: true });
  // Title says "Schema source of truth"; the RATIONALE mentions "zod" and
  // "drift" — terms absent from the title. ac-14 needs those body terms found.
  await writeFile(
    join(adrDir, 'ADR-0001-schema-source.md'),
    [
      '# ADR-0001: Schema source of truth',
      '',
      '## 결정',
      'zod schema가 source of truth이다.',
      '',
      '## 근거',
      'zod는 runtime 검증과 타입 추론을 한 정의로 제공해 drift 위험이 가장 작다.',
      '',
      '## 결과',
      '한 곳만 고치면 외부 view가 갱신된다.',
    ].join('\n'),
  );

  const knowledgeDir = join(root, '.ditto', 'knowledge');
  await writeFile(
    join(knowledgeDir, 'glossary.json'),
    JSON.stringify({
      schema_version: '0.1.0',
      project_name: 'ditto',
      updated_at: '2026-06-06T00:00:00.000Z',
      entries: [
        {
          term: 'work item',
          aliases: [],
          definition: 'DITTO가 추적하는 작업 단위. goal, acceptance criteria를 포함한다.',
          status: 'agreed',
        },
      ],
    }),
  );

  const archiveDir = join(root, '.ditto', 'local', 'handoff', 'archive');
  await mkdir(archiveDir, { recursive: true });
  const meta = {
    schema_version: '0.1.0',
    work_item_id: 'wi_demo',
    original_intent: '측정이 우선이겠네',
    current_state: 'final_verdict=partial; embedding 검색 인프라 일부 미검증',
    next_first_check: '미pass acceptance 검증',
    decisions_made: [],
    failed_or_unverified: ['ac-1 [unverified]'],
  };
  await writeFile(
    join(archiveDir, 'wi_demo__2026-06-08T00-00-00-000Z.md'),
    `---\n${JSON.stringify(meta)}\n---\n\n# Handoff: wi_demo\n`,
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-mem-boot-'));
  await mkdir(join(workDir, '.ditto'), { recursive: true });
  initGit(workDir);
  await seedKnowledge(workDir);
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('bootstrapIngest', () => {
  test('seeds the graph so it is not empty (ADR + glossary + handoff)', async () => {
    const r = await bootstrapIngest(workDir);
    // 3 sources: 1 ADR, 1 glossary, 1 handoff.
    expect(r.sourcesAdded.length).toBe(3);
    // events: 1 ADR decision + 1 glossary term observation + 1 handoff observation.
    expect(r.eventsAppended.length).toBe(3);

    const sources = await new MemorySourceStore(workDir).list();
    const events = await new MemoryEventStore(workDir).list();
    expect(sources.length).toBe(3);
    expect(events.length).toBe(3);

    // ADR event is approved → must carry approval invariant fields.
    const adrEvent = events.find((e) => e.event_type === 'decision');
    expect(adrEvent).toBeDefined();
    expect(adrEvent?.status).toBe('approved');
    expect(adrEvent?.approved_by).toBe('bootstrap');
    expect(adrEvent?.decided_at).toBeTruthy();

    // source types reflect the corpus.
    const types = sources.map((s) => s.source_type).sort();
    expect(types).toEqual(['note', 'spec', 'spec']);
  });

  test('is idempotent — a second run appends/adds nothing new', async () => {
    await bootstrapIngest(workDir);
    const second = await bootstrapIngest(workDir);
    expect(second.sourcesAdded.length).toBe(0);
    expect(second.eventsAppended.length).toBe(0);
    expect(second.sourcesSkipped.length).toBe(3);
    expect(second.eventsSkipped.length).toBe(3);

    // Total stays 3 — no duplicates created.
    const events = await new MemoryEventStore(workDir).list();
    expect(events.length).toBe(3);
  });

  test('body search has wider recall than title-token duplicateSearch (ac-14)', async () => {
    await bootstrapIngest(workDir);
    const events = await new MemoryEventStore(workDir).list();

    // "drift" lives in the ADR RATIONALE body, NOT in the ADR title.
    const query = 'drift';

    // Title-token baseline: the duplicateSearch over the document title finds nothing.
    const titleBaseline = duplicateSearch(query, [
      { id: 'adr', title: 'ADR-0001: Schema source of truth' },
    ]);
    expect(titleBaseline.length).toBe(0);

    // Body search over the ingested event text DOES find it → wider recall.
    const bodyHits = searchEventBodies(query, events);
    expect(bodyHits.length).toBeGreaterThan(0);
    expect(
      bodyHits.some(
        (h) => h.event_id === events.find((e) => e.event_type === 'decision')?.event_id,
      ),
    ).toBe(true);

    // Same property for a handoff FINDING term ("embedding") absent from any title.
    const handoffQuery = 'embedding';
    const handoffTitleBaseline = duplicateSearch(handoffQuery, [
      { id: 'h', title: 'Handoff: wi_demo' },
    ]);
    expect(handoffTitleBaseline.length).toBe(0);
    expect(searchEventBodies(handoffQuery, events).length).toBeGreaterThan(0);
  });
});
