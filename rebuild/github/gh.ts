import type { RepoCoord } from './coord';

/**
 * The injected GitHub access boundary. The live `gh` CLI (auth, version,
 * network) is externalized to the host-shell layer per ADR-20260628 — this
 * contract never spawns a subprocess. Callers wire a real implementation; tests
 * stub it. The boundary is split by DIRECTION on purpose (see the one-way mirror
 * invariant below).
 */

/** A best-effort GitHub result. Degradation is a value, never a throw (ADR-0018). */
export type GhResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** A raw issue as read from the GitHub backlog. */
export interface BacklogIssue {
  /** `owner/name` of the issue's repo. */
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
}

/**
 * READ side (layers 1 & 2 direction): the backlog is GitHub's source of truth,
 * ditto only reads it. This interface exposes NO write — structurally it can
 * never mutate GitHub state.
 */
export interface BacklogReader {
  listIssues(): GhResult<BacklogIssue[]>;
}

/**
 * WRITE side (layer 3, completion mirror): the ONLY GitHub write ditto performs
 * is posting a completion result onto the linked issue — a one-way mirror of a
 * ditto-side verdict. This interface deliberately exposes NO way to write the
 * backlog-authoritative state (priority / board status / issue open-closed): a
 * mirror can never flip what GitHub owns. Adding such a method here would break
 * the one-way invariant, so it is absent by design.
 */
export interface MirrorWriter {
  postCompletionComment(coord: RepoCoord, body: string): GhResult<void>;
}
