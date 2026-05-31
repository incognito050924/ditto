import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completionContract } from '~/schemas/completion-contract';
import { commandLogEntry } from '~/schemas/evidence-log';
import { glossary } from '~/schemas/glossary';
import { languageLedger } from '~/schemas/language-ledger';
import { reviewerOutput } from '~/schemas/reviewer-output';
import { runManifest } from '~/schemas/run-manifest';
import { workItem } from '~/schemas/work-item';

const FIXTURE_ROOT = join(
  import.meta.dir,
  '..',
  'fixtures',
  'scenarios',
  'password-strength',
  '.ditto',
);

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(join(FIXTURE_ROOT, path), 'utf8');
  return JSON.parse(text);
}

describe('password-strength golden fixture', () => {
  test('work-item.json conforms to workItem schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/work-item.json');
    const parsed = workItem.parse(data);
    expect(parsed.id).toBe('wi_pwdcheck');
    expect(parsed.status).toBe('partial');
    expect(parsed.acceptance_criteria).toHaveLength(3);
    expect(parsed.runs).toEqual(['run_pwdcheck1']);
  });

  test('run manifest conforms to runManifest schema', async () => {
    const data = await loadJson('runs/run_pwdcheck1/manifest.json');
    const parsed = runManifest.parse(data);
    expect(parsed.work_item_id).toBe('wi_pwdcheck');
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.verifications).toHaveLength(3);
    expect(parsed.unverified.length).toBeGreaterThan(0);
  });

  test('completion claim conforms to completionContract schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/completion.json');
    const parsed = completionContract.parse(data);
    expect(parsed.final_verdict).toBe('partial');
    expect(parsed.next_handoff_path).toBeDefined();
    expect(parsed.acceptance.map((a) => a.criterion_id).sort()).toEqual(['ac-1', 'ac-2', 'ac-3']);
  });

  test('reviewer output conforms to reviewerOutput schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/reviews/rv_pwdcheck1.json');
    const parsed = reviewerOutput.parse(data);
    expect(parsed.kind).toBe('cross-provider-reviewer');
    expect(parsed.different_provider_than_generator).toBe(true);
    expect(parsed.verdict).toBe('partial');
  });

  test('glossary conforms to glossary schema', async () => {
    const data = await loadJson('knowledge/glossary.json');
    const parsed = glossary.parse(data);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(3);
    const terms = parsed.entries.map((e) => e.term);
    expect(terms).toContain('password policy');
  });

  test('language ledger conforms to languageLedger schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/language-ledger.json');
    const parsed = languageLedger.parse(data);
    expect(parsed.work_item_id).toBe('wi_pwdcheck');
    expect(parsed.changes).toEqual([]);
  });

  test('commands.jsonl lines conform to commandLogEntry schema', async () => {
    const text = await readFile(
      join(FIXTURE_ROOT, 'work-items/wi_pwdcheck/evidence/commands.jsonl'),
      'utf8',
    );
    const lines = text.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      commandLogEntry.parse(JSON.parse(line));
    }
  });
});

describe('schema rejects invalid documents', () => {
  test('completion contract rejects final_verdict=pass with non-pass acceptance', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_bad0001',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: '실패한 acceptance로 pass를 주장하는 잘못된 contract',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'fail', evidence: [] }],
      verifications: [],
      unverified: [],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('completion contract rejects non-pass without next_handoff_path', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_bad0002',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'partial을 주장하면서 handoff 경로를 빠뜨림',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'partial', evidence: [] }],
      verifications: [],
      unverified: [],
      remaining_risks: [],
      final_verdict: 'partial',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('work item id rejects bad prefix', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wrong-prefix',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('relative path rejects parent traversal', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_traverse',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      changed_files: ['../etc/passwd'],
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('reviewer output unverified verdict requires evidence or review_not_run_reason', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'rv_bad0001',
      work_item_id: 'wi_bad0001',
      kind: 'verifier',
      reviewer: 'verifier',
      different_provider_than_generator: false,
      started_at: '2026-05-24T00:00:00+09:00',
      verdict: 'unverified',
      evidence: [],
      findings: [],
      unverified: [],
      recommended_next_action: 'next',
    };
    expect(() => reviewerOutput.parse(bad)).toThrow();
  });

  test('completion contract rejects final_verdict=pass with in-scope unverified', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_unverif1',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'pass를 주장하면서 in-scope unverified가 남아 있음',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [] }],
      verifications: [],
      unverified: [{ item: '회귀 테스트', reason: '시간 부족', out_of_scope: false }],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('completion contract allows final_verdict=pass when all unverified marked out_of_scope', () => {
    const ok = {
      schema_version: '0.1.0',
      work_item_id: 'wi_outscop1',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'out_of_scope unverified만 남기고 pass 주장',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [] }],
      verifications: [],
      unverified: [{ item: '다른 OS 검증', reason: '본 PR 범위 밖', out_of_scope: true }],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(ok)).not.toThrow();
  });

  test('work item rejects non-terminal status without re_entry', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_blocked1',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      status: 'blocked',
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('work item rejects partial status with empty re_entry', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_partial1',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'partial' }],
      status: 'partial',
      re_entry: { fresh_evidence_needed: [] },
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('work item allows partial status when re_entry.command is set', () => {
    const ok = {
      schema_version: '0.1.0',
      id: 'wi_partial2',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'partial' }],
      status: 'partial',
      re_entry: { command: 'ditto work resume wi_partial2', fresh_evidence_needed: [] },
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(ok)).not.toThrow();
  });

  test('command log entry rejects missing required fields', () => {
    const bad = {
      ts: '2026-05-24T00:00:00+09:00',
      kind: 'command',
      // command missing
      exit_code: 0,
    };
    expect(() => commandLogEntry.parse(bad)).toThrow();
  });

  test('command log entry rejects wrong kind discriminator', () => {
    const bad = {
      ts: '2026-05-24T00:00:00+09:00',
      kind: 'note',
      command: 'echo hi',
      exit_code: 0,
    };
    expect(() => commandLogEntry.parse(bad)).toThrow();
  });
});
