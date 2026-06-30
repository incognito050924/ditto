/**
 * journey-authoring — shared core of the two authoring surfaces
 * (① story→journey→E2E, ② journey→E2E). A start/record/finalize state machine
 * whose finalize compiles a per-work-item draft buffer into ADR-0005 per-entity
 * journey/story files + journey DSL files, with fail-closed conflict/reference
 * gates and the spec_first / superseded lifecycle transitions.
 */
export { decomposeIntent } from './decompose';
export type { DecomposeDraft, StepDraft } from './decompose';
export { assertKebabSlug, dslSlug, journeyId, storyId } from './ids';
export { renderJourneyDsl } from './dsl';
export { JourneyAuthoringStore } from './store';
export {
  journeyAuthoringState,
  journeyDraft,
  storyDraft,
} from './session-state';
export type {
  JourneyAuthoringState,
  JourneyDraft,
  StoryDraft,
} from './session-state';
export {
  IdConflictError,
  JourneyReferenceNotFoundError,
  finalizeAuthoring,
  recordJourney,
  recordStory,
  startAuthoring,
} from './session';
export type {
  FinalizeAuthoringInput,
  FinalizeAuthoringResult,
  RecordJourneyInput,
  RecordStoryInput,
  StartAuthoringInput,
} from './session';
