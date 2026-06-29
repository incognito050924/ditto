import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecipe } from '~/core/recipe/parse';

// ac-7 (wi_260629i9c) — DOGFOOD: ditto's OWN hardcoded pre-push is replaced by the
// recipe-driven gate, while keeping all-branch testing and the surfaces:gen prestep.
// Deterministic unit test: read the checked-in files, assert structure. NO real push.

const REPO_ROOT = join(import.meta.dir, '..', '..');
const recipeText = readFileSync(join(REPO_ROOT, 'recipe.yaml'), 'utf8');
const prePush = readFileSync(join(REPO_ROOT, '.githooks', 'pre-push'), 'utf8');

describe('recipe.yaml — ditto root push_gate keeps all-branch DoD testing', () => {
  test('parses as a valid recipe with a push_gate block', () => {
    const r = parseRecipe(recipeText);
    expect(r.ok).toBe(true);
  });

  test('push_gate protects ALL branches ("*") and runs "bun test"', () => {
    const r = parseRecipe(recipeText);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.recipe.push_gate).toEqual({
        protected_branches: ['*'],
        test_command: 'bun test',
      });
  });
});

describe('.githooks/pre-push — delegates the gate to ditto push-gate, keeps ditto-specific presteps', () => {
  test('delegates the test gate to ./bin/ditto push-gate', () => {
    expect(prePush).toContain('./bin/ditto push-gate');
  });

  test('does NOT call `bun test` directly as the gate core (delegated to the recipe)', () => {
    // The gate runs `bun test` only THROUGH the recipe's test_command via push-gate;
    // the hook script itself must not invoke the runner directly anymore.
    expect(prePush).not.toMatch(/^\s*(if\s+!\s+)?bun test\b/m);
  });

  test('keeps the NON-BLOCKING surfaces:gen prestep (failure → warn + proceed)', () => {
    // `bun run surfaces:gen ... || echo ...` — the `||` proves it does not block.
    expect(prePush).toMatch(/bun run surfaces:gen[^\n]*\|\|[^\n]*echo/);
  });

  test('keeps the bun-absent graceful skip at the top', () => {
    expect(prePush).toContain('command -v bun');
    expect(prePush).toMatch(/command -v bun[\s\S]*exit 0/);
  });

  test('preserves the DITTO_SKIP_HOOKS / --no-verify bypass guidance', () => {
    expect(prePush).toContain('DITTO_SKIP_HOOKS');
    expect(prePush).toContain('--no-verify');
  });

  test('stays a POSIX sh script', () => {
    expect(prePush.startsWith('#!/bin/sh')).toBe(true);
  });
});
