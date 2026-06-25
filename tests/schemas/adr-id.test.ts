import { describe, expect, test } from 'bun:test';
import { ADR_ID_FULL_RE } from '~/schemas/adr-id';

// ADR_ID_FULL_RE is the anchored full-id validator shared by the knowledge-record
// and decision-conflict-carrier schemas (src/schemas/adr-id.ts). These cases used to
// ride along in knowledge-record.test.ts via the decisions[].id field; they moved
// here when that index was retired (wi_2606247cx) so the regex keeps direct coverage.
describe('ADR_ID_FULL_RE (shared ADR id validator)', () => {
  const matches = (id: string) => ADR_ID_FULL_RE.test(id);

  test('accepts legacy ADR-NNNN (exactly 4 digits)', () => {
    expect(matches('ADR-0024')).toBe(true);
    expect(matches('ADR-0001')).toBe(true);
  });

  test('accepts new ADR-YYYYMMDD-slug', () => {
    expect(matches('ADR-20260624-some-slug')).toBe(true);
  });

  test('rejects malformed ids', () => {
    // lowercase + too short
    expect(matches('adr-1')).toBe(false);
    // bare 8-digit date with no slug tail is ambiguous → rejected
    expect(matches('ADR-20260624')).toBe(false);
    // slug charset is lowercase alphanumeric words; uppercase/underscore rejected
    expect(matches('ADR-20260624-Bad_Slug')).toBe(false);
  });
});
