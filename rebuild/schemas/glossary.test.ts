import { describe, expect, test } from 'bun:test';

import { glossary, glossaryEntry } from './glossary';

describe('glossary schema — the ubiquitous-language index', () => {
  test('accepts a minimal entry and fills defaults', () => {
    const parsed = glossaryEntry.parse({ term: 'autopilot', definition: '무인 진행 오케스트레이터' });
    expect(parsed.status).toBe('agreed');
    expect(parsed.aliases).toEqual([]);
    expect(parsed.examples).toEqual([]);
    expect(parsed.not_to_be_confused_with).toEqual([]);
    expect(parsed.forbidden_abbreviations).toEqual([]);
  });

  test('rejects empty term, empty definition, and over-length fields', () => {
    expect(() => glossaryEntry.parse({ term: '', definition: 'x' })).toThrow();
    expect(() => glossaryEntry.parse({ term: 'x', definition: '' })).toThrow();
    expect(() => glossaryEntry.parse({ term: 'x'.repeat(81), definition: 'd' })).toThrow();
    expect(() => glossaryEntry.parse({ term: 't', definition: 'x'.repeat(801) })).toThrow();
  });

  test('status is a closed lifecycle enum', () => {
    expect(glossaryEntry.parse({ term: 't', definition: 'd', status: 'proposed' }).status).toBe(
      'proposed',
    );
    expect(() => glossaryEntry.parse({ term: 't', definition: 'd', status: 'draft' })).toThrow();
  });

  test('glossary file shape: schema_version + project_name + updated_at + entries', () => {
    const parsed = glossary.parse({
      schema_version: '0.1.0',
      project_name: 'ditto',
      updated_at: '2026-07-24T00:00:00.000Z',
      entries: [{ term: 'oracle', definition: '검증 신탁' }],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(() =>
      glossary.parse({ schema_version: '0.1.0', project_name: '', updated_at: 'x', entries: [] }),
    ).toThrow();
  });

  test('unknown keys are rejected (strict) so silent field drift surfaces', () => {
    expect(() =>
      glossaryEntry.parse({ term: 't', definition: 'd', unknown_field: true }),
    ).toThrow();
  });
});
