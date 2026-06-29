import { describe, expect, test } from 'bun:test';
import {
  CLAIM_AUTODETECT_TABLE,
  autodetectStatusMaps,
  matchStatusOptions,
  normalizeStatusName,
} from '~/core/github-status-match';

// The user's live board (wi_2606289h9): Backlog, Ready, In progress (47fc9ee4),
// In review, Done (98236657). No Blocked column.
const USER_BOARD = [
  { id: 'opt_backlog', name: 'Backlog' },
  { id: 'opt_ready', name: 'Ready' },
  { id: '47fc9ee4', name: 'In progress' },
  { id: 'opt_inreview', name: 'In review' },
  { id: '98236657', name: 'Done' },
];

describe('normalizeStatusName - exact-set (case/space/_/-) only', () => {
  test('absorbs case, space, underscore, hyphen', () => {
    expect(normalizeStatusName('In progress')).toBe('inprogress');
    expect(normalizeStatusName('In Progress')).toBe('inprogress');
    expect(normalizeStatusName('in_progress')).toBe('inprogress');
    expect(normalizeStatusName('in-progress')).toBe('inprogress');
    expect(normalizeStatusName('  In   Progress  ')).toBe('inprogress');
  });
  test('does NOT fuzzy-match a different word', () => {
    expect(normalizeStatusName('Doing')).not.toBe('inprogress');
  });
});

describe('matchStatusOptions - exact-set, ambiguity-safe', () => {
  test('exactly-one match yields the option id', () => {
    const r = matchStatusOptions(USER_BOARD, CLAIM_AUTODETECT_TABLE);
    expect(r.matched).toEqual({ in_progress: '47fc9ee4' });
    expect(r.ambiguous).toEqual({});
  });
  test('no match (no In progress column) yields nothing — never a find-first guess', () => {
    const r = matchStatusOptions(
      [
        { id: 'a', name: 'Backlog' },
        { id: 'b', name: 'Done' },
      ],
      CLAIM_AUTODETECT_TABLE,
    );
    expect(r.matched).toEqual({});
    expect(r.ambiguous).toEqual({});
  });
  test('normalization collision (>1) is ambiguous — left unset, not guessed (C4)', () => {
    const r = matchStatusOptions(
      [
        { id: 'x', name: 'In Progress' },
        { id: 'y', name: 'in-progress' },
      ],
      CLAIM_AUTODETECT_TABLE,
    );
    expect(r.matched.in_progress).toBeUndefined();
    expect(r.ambiguous.in_progress).toEqual(['In Progress', 'in-progress']);
  });
});

describe('autodetectStatusMaps - both maps from the user board', () => {
  test('detects in_progress (claim) and done (terminal)', () => {
    const r = autodetectStatusMaps(USER_BOARD);
    expect(r.claimStatusMap).toEqual({ in_progress: '47fc9ee4' });
    expect(r.statusMap).toEqual({ done: '98236657' });
    expect(r.warnings).toEqual([]);
  });
  test('ambiguity surfaces a warning, leaves the key unset', () => {
    const r = autodetectStatusMaps([
      { id: 'x', name: 'In Progress' },
      { id: 'y', name: 'in_progress' },
    ]);
    expect(r.claimStatusMap.in_progress).toBeUndefined();
    expect(r.warnings.join(' ')).toContain('ambiguous');
  });
});
