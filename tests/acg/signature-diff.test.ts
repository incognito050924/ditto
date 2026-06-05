import { describe, expect, test } from 'bun:test';
import { diffExportedSignatures, extractExportedSignatures } from '~/acg/semantic/signature-diff';

// O7 (wi_260605de1) — static signature extractor. The Opponent named the exact
// fixtures a regex would miss: generics, overloads, arrow exports, re-exports,
// default exports. These are the regression set.

describe('extractExportedSignatures', () => {
  test('exported function declaration → normalized signature', () => {
    const sigs = extractExportedSignatures('export function getUser(id: string): User | null {}');
    expect(sigs.get('getUser')).toBe('getUser(id: string): User | null');
  });

  test('generic type parameters are part of the signature', () => {
    const sigs = extractExportedSignatures('export function map<T, U>(x: T, f: (t: T) => U): U {}');
    expect(sigs.get('map')).toBe('map<T, U>(x: T, f: (t: T) => U): U');
  });

  test('exported const arrow function is captured', () => {
    const sigs = extractExportedSignatures(
      'export const add = (a: number, b: number): number => a + b;',
    );
    expect(sigs.get('add')).toBe('add(a: number, b: number): number');
  });

  test('overload set is joined (so an overload change is visible)', () => {
    const src = [
      'export function f(a: string): string;',
      'export function f(a: number): number;',
      'export function f(a: unknown): unknown { return a; }',
    ].join('\n');
    const sig = extractExportedSignatures(src).get('f');
    expect(sig).toContain('f(a: string): string');
    expect(sig).toContain('f(a: number): number');
  });

  test('non-exported functions are ignored', () => {
    const sigs = extractExportedSignatures('function hidden(a: string): void {}');
    expect(sigs.has('hidden')).toBe(false);
  });

  test('default export and re-export are out of scope (not captured)', () => {
    const src = [
      'export default function boot(): void {}',
      "export { thing } from './other';",
    ].join('\n');
    const sigs = extractExportedSignatures(src);
    expect(sigs.has('boot')).toBe(false);
    expect(sigs.has('thing')).toBe(false);
  });
});

describe('diffExportedSignatures', () => {
  test('a changed signature is reported as before→after', () => {
    const before = 'export function getUser(id: string): User | null {}';
    const after = 'export function getUser(id: string): User {}';
    const changes = diffExportedSignatures(before, after);
    expect(changes).toEqual([
      {
        symbol: 'getUser',
        before: 'getUser(id: string): User | null',
        after: 'getUser(id: string): User',
      },
    ]);
  });

  test('unchanged signatures produce no change', () => {
    const src = 'export function f(a: string): void {}';
    expect(diffExportedSignatures(src, src)).toEqual([]);
  });

  test('added and deleted exports are not signature-shape changes (out of scope)', () => {
    const before = 'export function a(): void {}';
    const after =
      'export function a(): void {}\nexport function b(x: number): number { return x; }';
    expect(diffExportedSignatures(before, after)).toEqual([]);
  });

  test('a body-only change (same signature) produces no change', () => {
    const before = 'export function f(a: number): number { return a; }';
    const after = 'export function f(a: number): number { return a * 2; }';
    expect(diffExportedSignatures(before, after)).toEqual([]);
  });

  test('multiple changed signatures are all reported', () => {
    const before =
      'export function a(x: string): void {}\nexport function b(y: number): number { return y; }';
    const after =
      'export function a(x: number): void {}\nexport function b(y: string): number { return 0; }';
    const changes = diffExportedSignatures(before, after);
    expect(changes.map((c) => c.symbol).sort()).toEqual(['a', 'b']);
  });
});
