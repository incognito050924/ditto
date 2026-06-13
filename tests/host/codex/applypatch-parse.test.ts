// Codex host surface: apply_patch path extraction (N4, wi_260613f9d).
//
// Unit tests for the apply_patch header parser + the host-aware mutatedPaths
// normalizer. Codex sends edits as tool_name="apply_patch" with the touched
// paths inside tool_input.command; these functions surface those paths so the
// PreToolUse gates and PostToolUse evidence iterate them. Integration of the
// gate/evidence wiring is a separate node (N6) — this file is parser-only.
import { describe, expect, test } from 'bun:test';
import { mutatedPaths, parseApplyPatchPaths } from '~/hooks/envelope';

describe('parseApplyPatchPaths', () => {
  test('single Add File', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/a.ts',
      '+const a = 1;',
      '*** End Patch',
    ].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/a.ts']);
  });

  test('single Update File', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/b.ts',
      '@@',
      '-const b = 1;',
      '+const b = 2;',
      '*** End Patch',
    ].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/b.ts']);
  });

  test('single Delete File', () => {
    const patch = ['*** Begin Patch', '*** Delete File: src/c.ts', '*** End Patch'].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/c.ts']);
  });

  test('multi-file patch returns every header path in order', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/a.ts',
      '+x',
      '*** Update File: src/b.ts',
      '@@',
      '+y',
      '*** Delete File: src/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('Move to (rename) yields both the old and new path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '@@',
      '+z',
      '*** End Patch',
    ].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/old.ts', 'src/new.ts']);
  });

  test('de-duplicates a repeated header path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/dup.ts',
      '*** Move to: src/dup.ts',
      '*** End Patch',
    ].join('\n');
    expect(parseApplyPatchPaths(patch)).toEqual(['src/dup.ts']);
  });

  test('tolerates trailing whitespace around the path', () => {
    expect(parseApplyPatchPaths('*** Add File:   spaced/path.ts   ')).toEqual(['spaced/path.ts']);
  });

  test('no headers → empty', () => {
    expect(parseApplyPatchPaths('just some text\n+a line')).toEqual([]);
  });
});

describe('mutatedPaths — host-aware normalizer', () => {
  test('Codex apply_patch → patch header paths', () => {
    const raw = {
      tool_name: 'apply_patch',
      tool_input: { command: '*** Add File: src/a.ts\n*** Update File: src/b.ts' },
    };
    expect(mutatedPaths('codex', raw)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('Claude Write/Edit/MultiEdit → single file_path (byte-identical shape)', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const raw = { tool_name: tool, tool_input: { file_path: 'src/x.ts' } };
      expect(mutatedPaths('claude-code', raw)).toEqual(['src/x.ts']);
      // The Claude single-path shape is also recognized under the codex host
      // (the apply_patch branch only triggers for tool_name="apply_patch").
      expect(mutatedPaths('codex', raw)).toEqual(['src/x.ts']);
    }
  });

  test('apply_patch under claude-code host is NOT parsed (falls through to []),', () => {
    const raw = { tool_name: 'apply_patch', tool_input: { command: '*** Add File: src/a.ts' } };
    expect(mutatedPaths('claude-code', raw)).toEqual([]);
  });

  test('non-edit tool / missing field → empty', () => {
    expect(mutatedPaths('codex', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual([]);
    expect(mutatedPaths('codex', { tool_name: 'apply_patch', tool_input: {} })).toEqual([]);
    expect(mutatedPaths('claude-code', { tool_name: 'Write', tool_input: {} })).toEqual([]);
    expect(mutatedPaths('claude-code', {})).toEqual([]);
  });
});
