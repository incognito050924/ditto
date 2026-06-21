import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapIngest } from '~/core/memory-bootstrap';
import { searchEventBodies } from '~/core/memory-query';
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
      '- 상태: accepted',
      '- 관련: ADR-0005, `reports/design/schema.md`, `src/schemas/common.ts`, `src/core/memory-build.ts`',
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

  test('ADR `관련:` header populates decision.governs with code paths only', async () => {
    await bootstrapIngest(workDir);
    const events = await new MemoryEventStore(workDir).list();
    const adrEvent = events.find((e) => e.event_type === 'decision');
    // ADR-0005 (decision ref) and reports/design/schema.md (doc) are excluded;
    // only src/ code paths become governs, order preserved.
    expect(adrEvent?.governs).toEqual(['src/schemas/common.ts', 'src/core/memory-build.ts']);
  });

  test('glossary/handoff events are ingested as status=approved (carry approval invariant)', async () => {
    await bootstrapIngest(workDir);
    const events = await new MemoryEventStore(workDir).list();

    // glossary + handoff are observations; both must be approved so projection sees them.
    const observations = events.filter((e) => e.event_type === 'observation');
    expect(observations.length).toBe(2);
    for (const e of observations) {
      expect(e.status).toBe('approved');
      expect(e.approved_by).toBe('bootstrap');
      expect(e.decided_at).toBeTruthy();
    }
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

  test('re-ingest after ADR content changes updates the source content_hash (F5); event body stays immutable', async () => {
    await bootstrapIngest(workDir);
    const sourceStore = new MemorySourceStore(workDir);
    // The ADR is the only `decision` event; its single source is the ADR source.
    const adrEventBefore = (await new MemoryEventStore(workDir).list()).find(
      (e) => e.event_type === 'decision',
    );
    expect(adrEventBefore).toBeDefined();
    const adrSourceId = adrEventBefore?.sources[0] ?? '';
    const adrEventId = adrEventBefore?.event_id ?? '';
    const adrSourceBefore = await sourceStore.get(adrSourceId);

    // Edit the curated ADR body — the rationale now mentions a new term.
    const adrPath = join(workDir, '.ditto', 'knowledge', 'adr', 'ADR-0001-schema-source.md');
    await writeFile(
      adrPath,
      [
        '# ADR-0001: Schema source of truth',
        '',
        '## 결정',
        'zod schema가 source of truth이다.',
        '',
        '## 근거',
        'zod는 runtime 검증을 한 정의로 제공하고 telemetry 회귀 위험이 작다.',
      ].join('\n'),
    );

    const second = await bootstrapIngest(workDir);
    // The changed source is re-written (surfaced via sourcesAdded, not skipped).
    expect(second.sourcesAdded).toContain(adrSourceId);
    expect(second.sourcesSkipped).not.toContain(adrSourceId);

    const adrSourceAfter = await sourceStore.get(adrSourceId);
    expect(adrSourceAfter.content_hash).not.toBe(adrSourceBefore.content_hash);

    // Limitation pinned: the immutable event body is NOT refreshed by re-ingest
    // (same event_id is graceful-skipped, supersede path absent — ADR-0013).
    expect(second.eventsSkipped).toContain(adrEventId);
    const adrEventAfter = (await new MemoryEventStore(workDir).list()).find(
      (e) => e.event_type === 'decision',
    );
    expect(adrEventAfter?.event_id).toBe(adrEventId);
    expect(adrEventAfter?.text).toBe(adrEventBefore?.text);
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

  test('rejected-alternative and change-condition terms are searchable (prohibition recall)', async () => {
    // A decision whose PROHIBITION lives in "대안 (기각)" and whose validity
    // window lives in "철회/재검토 조건" — neither term appears in 결정/근거. The
    // gist must capture these sections, else "we decided NOT to do X" and "when
    // does this decision expire" are invisible to the retrieval that the
    // decision-contradiction guardrail depends on.
    const adrDir = join(workDir, '.ditto', 'knowledge', 'adr');
    await writeFile(
      join(adrDir, 'ADR-0002-engine.md'),
      [
        '# ADR-0002: Static engine choice',
        '',
        '## 결정',
        'CodeQL 단일 엔진을 쓴다.',
        '',
        '## 근거',
        '단일 분석 파이프라인이 유지보수가 싸다.',
        '',
        '## 대안 (기각)',
        '- kafka 기반 스트리밍 분석기 — 운영 부담으로 기각.',
        '',
        '## 철회/재검토 조건',
        'petabyte 규모 코드베이스가 생기면 다시 연다.',
      ].join('\n'),
    );

    await bootstrapIngest(workDir);
    const events = await new MemoryEventStore(workDir).list();
    const decisionIds = new Set(
      events.filter((e) => e.event_type === 'decision').map((e) => e.event_id),
    );

    // Rejected-alternative term — encodes "we decided NOT to adopt kafka".
    const rejectHits = searchEventBodies('kafka', events);
    expect(rejectHits.some((h) => decisionIds.has(h.event_id))).toBe(true);

    // Change-condition term — when the decision should be revisited.
    const condHits = searchEventBodies('petabyte', events);
    expect(condHits.some((h) => decisionIds.has(h.event_id))).toBe(true);
  });
});
