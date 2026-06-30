/**
 * Deterministic identity helpers for journey/story authoring.
 *
 * The author supplies a kebab `slug` (the content-derived identity); the machine
 * never rolls a random/timestamp id (plan_brief: "id는 work-item/콘텐츠 파생
 * 결정적, random/timestamp 금지"). The same slug therefore always maps to the
 * same `jrn-`/`us-` id, the same per-entity file, and the same DSL filename —
 * which is what makes finalize idempotent (ac-3).
 */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Throw if `slug` is not kebab-case (the shared identity charset). */
export function assertKebabSlug(slug: string): void {
  if (!KEBAB.test(slug)) {
    throw new Error(`slug must be kebab-case ([a-z0-9] joined by single hyphens): "${slug}"`);
  }
}

/** `checkout` → `jrn-checkout` (journey machine id). */
export function journeyId(slug: string): string {
  assertKebabSlug(slug);
  return `jrn-${slug}`;
}

/** `shop` → `us-shop` (story machine id). */
export function storyId(slug: string): string {
  assertKebabSlug(slug);
  return `us-${slug}`;
}

/** `jrn-checkout` → `checkout` (the DSL filename stem under e2e/journeys). */
export function dslSlug(jrnId: string): string {
  return jrnId.replace(/^jrn-/, '');
}
