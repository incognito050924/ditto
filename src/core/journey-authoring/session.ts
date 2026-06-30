import { join } from 'node:path';
import type { AcgJourneySpec } from '~/schemas/acg-journey-spec';
import type { AcgStorySpec } from '~/schemas/acg-story-spec';
import { parseJourneyDoc } from '../e2e/journey-dsl';
import { atomicWriteText } from '../fs';
import { fileExists } from '../hosts/shared';
import { renderJourneyDsl } from './dsl';
import { dslSlug, journeyId, storyId } from './ids';
import {
  type JourneyDraftInput,
  type StoryDraftInput,
  journeyDraft,
  storyDraft,
} from './session-state';
import { JourneyAuthoringStore } from './store';

/**
 * Journey-authoring state machine (start → record → finalize), the shared core of
 * both surfaces (① story→journey→E2E, ② journey→E2E). Mirrors the tech-spec
 * start/recordSection/finalize shape: a per-work-item working buffer that finalize
 * compiles into durable per-entity artifacts. finalize is fail-closed — every
 * conflict/reference gate runs BEFORE any file is written (tech-spec invariant).
 */

/** A jrn- id was already taken by a journey this session does not own (ac-4). */
export class IdConflictError extends Error {
  constructor(public readonly conflicts: { id: string; reason: string }[]) {
    super(
      `journey id conflict (fail-closed): ${conflicts.map((c) => `${c.id} — ${c.reason}`).join('; ')}`,
    );
    this.name = 'IdConflictError';
  }
}

/** A story referenced a journey id that is absent from the catalog (ac-8). */
export class JourneyReferenceNotFoundError extends Error {
  constructor(public readonly missing: string[]) {
    super(`referenced journeys not found in catalog (fail-closed): ${missing.join(', ')}`);
    this.name = 'JourneyReferenceNotFoundError';
  }
}

export interface StartAuthoringInput {
  workItemId: string;
  kind: 'story' | 'journey';
  now?: Date;
}

/** Initialize the authoring working buffer. */
export async function startAuthoring(repoRoot: string, input: StartAuthoringInput): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString();
  await new JourneyAuthoringStore(repoRoot).writeSession({
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    kind: input.kind,
    story: null,
    journeys: [],
    finalized: null,
    updated_at: nowIso,
  });
}

export interface RecordJourneyInput {
  workItemId: string;
  journey: JourneyDraftInput;
  now?: Date;
}

/** Upsert one journey draft by slug (same slug updates in place). */
export async function recordJourney(repoRoot: string, input: RecordJourneyInput): Promise<void> {
  const store = new JourneyAuthoringStore(repoRoot);
  const state = await store.getSession(input.workItemId);
  const nowIso = (input.now ?? new Date()).toISOString();
  // Parse at the boundary so schema defaults (steps/implemented) + surface
  // validation apply here, not silently at the full-state write.
  const journey = journeyDraft.parse(input.journey);
  const idx = state.journeys.findIndex((j) => j.slug === journey.slug);
  const journeys =
    idx === -1
      ? [...state.journeys, journey]
      : state.journeys.map((j, i) => (i === idx ? journey : j));
  await store.writeSession({ ...state, journeys, updated_at: nowIso });
}

export interface RecordStoryInput {
  workItemId: string;
  story: StoryDraftInput;
  now?: Date;
}

/** Set/overwrite the story draft (surface ①). */
export async function recordStory(repoRoot: string, input: RecordStoryInput): Promise<void> {
  const store = new JourneyAuthoringStore(repoRoot);
  const state = await store.getSession(input.workItemId);
  const nowIso = (input.now ?? new Date()).toISOString();
  await store.writeSession({ ...state, story: storyDraft.parse(input.story), updated_at: nowIso });
}

export type FinalizeAuthoringResult =
  | {
      status: 'finalized';
      journeys: AcgJourneySpec[];
      story: AcgStorySpec | null;
      dsl_paths: string[];
      superseded: string[];
    }
  | { status: 'not_started' };

export interface FinalizeAuthoringInput {
  workItemId: string;
  now?: Date;
}

/**
 * Compile the working buffer into per-entity journey/story files + DSL files.
 * The ownership key for the conflict gate is the story id (`us-…`) for a story
 * session, or `undefined` for a journey-only session: an existing per-entity file
 * whose `story_id` differs from ours is owned by someone else and the write is
 * refused (no silent overwrite/shadow).
 */
export async function finalizeAuthoring(
  repoRoot: string,
  input: FinalizeAuthoringInput,
): Promise<FinalizeAuthoringResult> {
  const store = new JourneyAuthoringStore(repoRoot);
  if (!(await store.sessionExists(input.workItemId))) return { status: 'not_started' };
  const state = await store.getSession(input.workItemId);
  const producedAt = (input.now ?? new Date()).toISOString();

  const ownerStoryId = state.story ? storyId(state.story.slug) : undefined;

  // Build the journey specs this session creates.
  const built = state.journeys.map((d) => {
    const id = journeyId(d.slug);
    const spec: AcgJourneySpec = {
      schema_version: '0.1.0',
      kind: 'acg.journey-spec.v1',
      produced_by: 'agent',
      produced_at: producedAt,
      id,
      // ac-6: no product code to resolve selectors ⇒ spec_first; built but not yet
      // E2E-run ⇒ awaiting_validation (validated only comes later from an E2E run).
      status: d.implemented ? 'awaiting_validation' : 'spec_first',
      ...(ownerStoryId ? { story_id: ownerStoryId } : {}),
      title: d.name,
      owner: d.owner,
      steps: d.steps,
      surfaces: d.surfaces,
      fixtures: [],
      evidence_requirement: { kind: 'e2e', must_pass_steps: d.steps.map((s) => s.step_id) },
    };
    // Render once here so the conflict gate can compare against an existing DSL
    // file byte-for-byte (idempotent re-finalize) and the write reuses it.
    const dsl = renderJourneyDsl({
      id: spec.id,
      name: d.name,
      description: d.description,
      surfaces: d.surfaces,
      steps: d.steps,
    });
    return { draft: d, spec, dsl };
  });
  const newIds = new Set(built.map((b) => b.spec.id));

  // ── gate 1: referenced journeys must exist (ac-8) ──
  if (state.story) {
    const missing: string[] = [];
    for (const ref of state.story.reference_journey_ids) {
      if (newIds.has(ref)) continue; // created here
      if (!(await store.getJourney(ref))) missing.push(ref);
    }
    if (missing.length > 0) throw new JourneyReferenceNotFoundError(missing);
  }

  // ── gate 2: id / slug conflict, fail-closed before any write (ac-4) ──
  const conflicts: { id: string; reason: string }[] = [];
  for (const { spec, dsl } of built) {
    const existing = await store.getJourney(spec.id);
    if (existing && (existing.story_id ?? undefined) !== ownerStoryId) {
      conflicts.push({
        id: spec.id,
        reason: `already owned by ${existing.story_id ?? '(journey-only)'}`,
      });
    }
    const dslPath = join(repoRoot, 'e2e', 'journeys', `${dslSlug(spec.id)}.journey.md`);
    if (await fileExists(dslPath)) {
      const existingText = await Bun.file(dslPath).text();
      const parsed = parseJourneyDoc(existingText);
      if (parsed.ok && parsed.frontMatter.id !== spec.id) {
        conflicts.push({ id: spec.id, reason: `DSL slug taken by ${parsed.frontMatter.id}` });
      } else if (existingText !== dsl) {
        // Same jrn- id (or unparsable) but content diverges from our deterministic
        // render: a hand-authored / external DSL we did not produce. Refuse to
        // silently overwrite it (no data loss). Byte-identical ⇒ our own prior
        // render ⇒ idempotent, no conflict (ac-3).
        conflicts.push({
          id: spec.id,
          reason: 'existing DSL diverges from generated output (hand-authored / not owned)',
        });
      }
    }
  }
  if (conflicts.length > 0) throw new IdConflictError(conflicts);

  // ── writes (all gates passed) ──
  const writtenJourneys: AcgJourneySpec[] = [];
  const dslPaths: string[] = [];
  for (const { spec, dsl } of built) {
    writtenJourneys.push(await store.writeJourney(spec));
    const rel = join('e2e', 'journeys', `${dslSlug(spec.id)}.journey.md`);
    await atomicWriteText(join(repoRoot, rel), dsl);
    dslPaths.push(rel);
  }

  // ── ac-7: parent-edit supersede — story children dropped since last finalize ──
  const superseded: string[] = [];
  if (ownerStoryId) {
    for (const existing of await store.loadAllJourneys()) {
      if (existing.story_id !== ownerStoryId) continue;
      if (newIds.has(existing.id)) continue;
      if (existing.status === 'superseded') continue;
      await store.writeJourney({ ...existing, status: 'superseded' });
      superseded.push(existing.id);
    }
  }

  // ── story per-entity file (surface ①) ──
  let writtenStory: AcgStorySpec | null = null;
  if (state.story) {
    const journeyIds = [
      ...newIds,
      ...state.story.reference_journey_ids.filter((r) => !newIds.has(r)),
    ];
    const story: AcgStorySpec = {
      schema_version: '0.1.0',
      kind: 'acg.story-spec.v1',
      produced_by: 'agent',
      produced_at: producedAt,
      id: ownerStoryId as string,
      ...(state.story.title ? { title: state.story.title } : {}),
      owner: state.story.owner,
      actor: state.story.actor,
      want: state.story.want,
      value: state.story.value,
      journey_ids: journeyIds,
    };
    writtenStory = await store.writeStory(story);
  }

  await store.writeSession({ ...state, finalized: { at: producedAt }, updated_at: producedAt });

  return {
    status: 'finalized',
    journeys: writtenJourneys,
    story: writtenStory,
    dsl_paths: dslPaths,
    superseded,
  };
}
