import { randomBytes } from 'node:crypto';
import { defineCommand } from 'citty';
import { readHandoffPushConsent, writeHandoffPushConsent } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  HandoffRefStore,
  type RefBaton,
  type RefConsumeResult,
  type RefWriteResult,
} from '~/core/handoff-ref-store';
import {
  type FetchHandoffResult,
  type RemoteVisibility,
  type SyncOp,
  type SyncResult,
  fetchHandoffRef,
  pendingUnpushed,
  purgeHandoffHistory,
  syncHandoffRef,
} from '~/core/handoff-ref-sync';
import { type Handoff, handoff as handoffSchema } from '~/schemas/handoff';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto handoff` (wi_260722g7h, g7h-impl-cli) — the BATON model over the hidden
 * ref store. A handoff is a user-initiated pure context carry that lives as a
 * commit on `refs/ditto/handoffs` (per-repo, shared by every linked worktree),
 * NEVER as a working-tree file or a branch commit:
 *
 *  - `write` builds the baton from flags (required --intent/--from/--state/--next
 *    plus the rich-field flags mapping onto the existing schema fields), commits
 *    it onto the hidden ref via `HandoffRefStore.write`, then auto-syncs
 *    (`syncHandoffRef`, fetch-first + push) with the module's class-preserved
 *    warning surface. The sync visibility gate is FAIL-CLOSED: repo visibility is
 *    resolved via `gh repo view` (absent/unresolvable → 'unknown', which the gate
 *    refuses like public); `--push-public` is the one-shot explicit opt-in, and
 *    `--consent-push-remote` records a standing per-project consent (ac-3,
 *    wi_2607239vu: origin-bound normalized URL + visibility stamp) under which
 *    subsequent writes auto-push — a private→public visibility flip suspends the
 *    grant until it is re-confirmed.
 *  - `consume [id]` is first-consumer-wins: the store returns the body ONLY after
 *    its update-ref CAS landed the deletion commit (a CAS loser re-reads and gets
 *    the DISTINCT `already_consumed` refusal — different message and exit from
 *    `not_found`/65). The deletion is then pushed (op 'consume': an offline push
 *    failure warns that the remote baton still exists — re-consume window open,
 *    at-most-duplicated never lost) BEFORE the body is emitted, so an online
 *    consume is finalized against the remote. With no id: exactly one pending
 *    baton auto-resolves; several → the pending set is printed and the caller
 *    must name one (exit 65, never a prompt).
 *  - `show [id]` is a read-only peek — no deletion, no marker, no push; same id
 *    resolution as consume.
 *  - `purge` is the secret-recall path: `purgeHandoffHistory` rewrites the LOCAL
 *    baton ref history to a single parentless root carrying the current tip tree
 *    and lease-pushes it, cutting a leaked blob out of the remote history. It
 *    requires an origin remote (a local-only repo has nothing to recall from)
 *    and goes through the same fail-closed visibility gate (`--push-public`
 *    opt-in) plus the scrub gate: a still-dirty tip tree refuses the purge.
 *  - Both consume and show run a fetch-only adopt (wi_2607220o1) BEFORE resolving
 *    pending batons, so a fresh clone / another PC discovers origin's batons
 *    instead of the local unborn-ref 0-state. Fetch is read-safe and is NOT
 *    gated by --push-public (the visibility gate concerns push only); an
 *    unreachable remote degrades to local-only resolution with the module's
 *    loud class-preserved warning.
 *
 * There is NO `list` subcommand: the multiple-pending disambiguation output of
 * consume/show is the discovery surface. The old two-tier file-store paths
 * (soft-consume markers, local/remote list routing, `--remote`) are gone from
 * this command. Every subcommand ends by re-surfacing the pending-unpushed
 * warning (`pendingUnpushed`) so unsynced local baton state stays loud.
 */

/** A safe generated session id when the caller does not pass `--session`. */
function generateSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
  return `sess-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** A flag value that cannot be turned into a valid baton — exit 65, not a stack. */
class HandoffUsageError extends Error {}

/** Normalize a repeatable flag (absent | single | repeated) into a string list. */
function toList(value: unknown, flag: string): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new HandoffUsageError(`${flag} expects a non-empty string value`);
    }
    out.push(item);
  }
  return out;
}

/** Split a `left::right` pair flag; both sides required non-empty. */
function splitPair(raw: string, flag: string): [string, string] {
  const idx = raw.indexOf('::');
  const left = idx === -1 ? '' : raw.slice(0, idx).trim();
  const right = idx === -1 ? '' : raw.slice(idx + 2).trim();
  if (left.length === 0 || right.length === 0) {
    throw new HandoffUsageError(
      `${flag} expects "<left>::<right>" with both sides non-empty (got: ${raw})`,
    );
  }
  return [left, right];
}

/**
 * Test seam (plan wi_2607239vu, sandbox finding): the production visibility probe
 * spawns `gh repo view`, so a hermetic unit test would otherwise hit the real gh
 * CLI / network. A test injects a fixed visibility here and clears it afterwards;
 * production leaves it null and keeps the gh path. Only the resolver is seamed —
 * everything downstream (the gate, the consent stamp) reads the injected value.
 */
let injectedRepoVisibility: RemoteVisibility | null = null;
export function __setRepoVisibilityForTest(v: RemoteVisibility | null): void {
  injectedRepoVisibility = v;
}

/**
 * Derive the `gh repo view` target (HOST/OWNER/REPO) from the origin URL so the
 * visibility probe inspects the PUSH TARGET itself — an argument-less `gh repo
 * view` reads gh's configured DEFAULT repo, which can point at a different
 * (possibly private) repo while origin was re-pointed at a public one, flipping
 * the gate open. https and ssh forge-style URLs are derivable; anything else
 * (e.g. a local path) returns null and the caller resolves 'unknown'
 * (fail-closed — same as an unresolvable gh probe).
 */
export function deriveVisibilityProbeTarget(originUrl: string): string | null {
  const url = normalizeOriginUrl(originUrl);
  const https = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)\/([^/]+)\/([^/]+)$/);
  if (https?.[1] && https[2] && https[3]) return `${https[1]}/${https[2]}/${https[3]}`;
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/([^/]+)$/);
  if (ssh?.[1] && ssh[2] && ssh[3]) return `${ssh[1]}/${ssh[2]}/${ssh[3]}`;
  return null;
}

/**
 * Resolve the ORIGIN remote's actual visibility for the sync gate via `gh repo
 * view <host/owner/repo>` — pinned to the push target, never gh's default repo.
 * Graceful degrade: gh absent / no origin / not a forge-style remote /
 * unparsable → 'unknown', which the gate treats fail-closed (refuses auto-push
 * unless --push-public).
 */
function resolveRepoVisibility(repoRoot: string): RemoteVisibility {
  if (injectedRepoVisibility !== null) return injectedRepoVisibility;
  const originUrl = resolveOriginUrl(repoRoot);
  const target = originUrl === null ? null : deriveVisibilityProbeTarget(originUrl);
  if (target === null) return 'unknown';
  try {
    const proc = Bun.spawnSync(['gh', 'repo', 'view', target, '--json', 'visibility'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return 'unknown';
    const parsed = JSON.parse(proc.stdout?.toString() ?? '') as { visibility?: unknown };
    const v = typeof parsed.visibility === 'string' ? parsed.visibility.toLowerCase() : '';
    if (v === 'private') return 'private';
    if (v === 'public') return 'public';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function hasOriginRemote(repoRoot: string): boolean {
  try {
    return (
      Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode === 0
    );
  } catch {
    return false;
  }
}

/**
 * Normalize an origin URL to the canonical form used as the write-push consent
 * KEY. The consent reader compares the stored `origin_url` VERBATIM (core keeps
 * that side dumb on purpose), so the CLI owns normalization and MUST apply the
 * same transform on both the write and the read side — otherwise `repo` and
 * `repo.git` (or a trailing slash) would be treated as different remotes and a
 * legitimate grant would be silently refused. Strips trailing slashes, then one
 * trailing `.git`, then any slash the `.git` strip exposed.
 */
function normalizeOriginUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** The current origin URL in its normalized consent-key form (null when absent). */
function resolveOriginUrl(repoRoot: string): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    const url = normalizeOriginUrl(proc.stdout?.toString() ?? '');
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Auto-sync the hidden ref with origin (fetch-first + push). Null when there is
 * no origin remote — a purely local repo stays silent instead of warning forever.
 * All warnings (offline/auth/scrub/visibility, class-preserved) go to stderr.
 * `knownRemoteSha` forwards a remote tip already observed by THIS command
 * (consume's pre-resolution fetch) so the sync skips its own initial fetch;
 * undefined keeps the fetch-first behavior.
 */
function runAutoSync(
  repoRoot: string,
  op: SyncOp,
  allowPublicRemote: boolean,
  visibility: RemoteVisibility,
  knownRemoteSha?: string | null,
): SyncResult | null {
  if (!hasOriginRemote(repoRoot)) return null;
  const result = syncHandoffRef(repoRoot, 'origin', {
    visibility,
    allowPublicRemote,
    op,
    // exactOptionalPropertyTypes: only materialize the key when a tip was observed.
    ...(knownRemoteSha !== undefined ? { knownRemoteSha } : {}),
  });
  for (const w of result.warnings) writeError(w);
  if (result.status === 'public-remote-refused') {
    if (op === 'consume') {
      // C6: a consume is refused on a public/unknown remote when its transmit set
      // is MORE than a pure deletion, when the remote base was unobservable, or on
      // an enumeration failure — the module's refusal warning above names the
      // exact cause (never re-asserted here: claiming a specific cause like "a
      // companion un-pushed write" can be false and misdirect the user).
      // buildSyncWarning attaches its re-consume-window NOTE to the offline/auth
      // classes but NOT to this refusal, so surface the same window here — and
      // state plainly what --push-public would publish, because on a public
      // remote that includes every un-pushed body in the local ref, possibly
      // content the user meant to retract by consuming it.
      writeError(
        "handoff sync: the consume deletion was NOT pushed to 'origin' — the delete-only exemption refused it (the warning above names why; a new handoff body must never reach a public/unknown remote). NOTE: the remote copy still exists, so another PC may still consume it (re-consume window open; at-most-duplicated, never lost). --push-public would push the FULL local ref — including any un-pushed handoff bodies — so pass it only if you intend to publish that content.",
      );
    } else {
      writeError('handoff sync: pass --push-public to opt in for a public/unknown remote.');
    }
  }
  return result;
}

/**
 * Fetch-only adopt BEFORE pending-baton resolution (consume/show): without it, a
 * fresh clone resolves against the local unborn ref and reports "no pending
 * batons" even though origin holds some (the write path's sync fetches first —
 * consume/show never did). Read-safe, so never gated by the push visibility
 * gate; offline/unreachable degrades to local-only resolution with the module's
 * loud class-preserved warning (the CLI keeps going — never a hard failure).
 * Returns the fetch result (null when there is no origin remote) so consume can
 * feed the observed remote sha into its post-CAS sync and skip a second fetch.
 */
function runPreResolutionFetch(repoRoot: string): FetchHandoffResult | null {
  if (!hasOriginRemote(repoRoot)) return null;
  const res = fetchHandoffRef(repoRoot, 'origin');
  for (const w of res.warnings) writeError(w);
  return res;
}

/**
 * The repeated pending-unpushed warning: every handoff command ends by checking
 * whether local baton state has landed on origin, so a one-shot offline warning
 * cannot silently scroll away.
 */
function warnPendingUnpushed(repoRoot: string): void {
  if (!hasOriginRemote(repoRoot)) return;
  const state = pendingUnpushed(repoRoot);
  if (!state.pending) return;
  writeError(
    `handoff sync: WARNING — local handoff baton state (tip ${state.localTip}) has NOT been pushed to 'origin'. Another PC cannot see it yet; it will be re-synced on the next handoff command run while online.`,
  );
}

/** Build the baton from the write flags; throws HandoffUsageError / ZodError on bad input. */
function buildBatonFromFlags(args: Record<string, unknown>): Handoff {
  const workItem = args['work-item'];
  const scope =
    typeof workItem === 'string' && workItem.trim().length > 0
      ? { kind: 'work_item', work_item_id: workItem }
      : {
          kind: 'session',
          session_id:
            typeof args.session === 'string' && args.session.trim().length > 0
              ? args.session
              : generateSessionId(),
        };
  return handoffSchema.parse({
    schema_version: '0.1.0',
    scope,
    ...(typeof args.autopilot === 'string' && args.autopilot.length > 0
      ? { autopilot_id: args.autopilot }
      : {}),
    from_context: args.from,
    original_intent: args.intent,
    current_state: args.state,
    decisions_made: toList(args.decision, '--decision'),
    critical_decisions: toList(args.critical, '--critical').map((raw) => {
      const [decision, rationale] = splitPair(raw, '--critical');
      return { decision, rationale };
    }),
    irreversible_risks: toList(args.risk, '--risk').map((raw) => {
      const [risk, why] = splitPair(raw, '--risk');
      return { risk, why_irreversible: why };
    }),
    changed_files: toList(args.changed, '--changed'),
    evidence_refs: toList(args.evidence, '--evidence').map((summary) => ({
      kind: 'note',
      summary,
    })),
    open_threads: toList(args.open, '--open'),
    next_first_check: args.next,
    forbidden_scope_creep: toList(args.forbid, '--forbid'),
    created_at: new Date().toISOString(),
  });
}

function scopeLabel(h: Handoff): string {
  return h.scope.kind === 'work_item'
    ? `work item ${h.scope.work_item_id}`
    : `session (${h.scope.session_id})`;
}

const writeArgs = {
  'work-item': {
    type: 'string',
    description: 'Scope the baton to a work item (else session scope with a generated id).',
    required: false,
  },
  session: {
    type: 'string',
    description: 'Explicit session id for a session-scope baton. Omit to generate a safe one.',
    required: false,
  },
  intent: {
    type: 'string',
    description: 'Original user intent (required).',
    required: false,
  },
  from: {
    type: 'string',
    description: 'Where this handoff is written from: session/agent and its state (required).',
    required: false,
  },
  state: {
    type: 'string',
    description: 'Where things stand now (required).',
    required: false,
  },
  next: {
    type: 'string',
    description: 'The single first thing the next agent should check (required).',
    required: false,
  },
  autopilot: {
    type: 'string',
    description: 'The autopilot_id the next session resumes under, if this resumes a run.',
    required: false,
  },
  decision: {
    type: 'string',
    description: 'A decision made this session (repeatable → decisions_made).',
    required: false,
  },
  critical: {
    type: 'string',
    description:
      'A non-rederivable decision as "decision::rationale" (repeatable → critical_decisions).',
    required: false,
  },
  risk: {
    type: 'string',
    description: 'An irreversible risk as "risk::why" (repeatable → irreversible_risks).',
    required: false,
  },
  open: {
    type: 'string',
    description: 'An open thread the next session must know (repeatable → open_threads).',
    required: false,
  },
  forbid: {
    type: 'string',
    description: 'A forbidden scope creep (repeatable → forbidden_scope_creep).',
    required: false,
  },
  evidence: {
    type: 'string',
    description: 'An inline evidence note (repeatable → evidence_refs as kind "note").',
    required: false,
  },
  changed: {
    type: 'string',
    description: 'A changed repo-relative file path (repeatable → changed_files).',
    required: false,
  },
  'push-public': {
    type: 'boolean',
    description:
      'One-shot explicit opt-in to auto-push the baton ref to a public/unknown-visibility remote (the gate is fail-closed otherwise; pushed history cannot be un-published). For a standing per-project grant use --consent-push-remote.',
    default: false,
  },
  'consent-push-remote': {
    type: 'boolean',
    description:
      'Record standing write-push consent for THIS origin: this and subsequent `handoff write` pushes to the public/unknown-visibility remote proceed without re-prompting. Origin-bound (a re-pointed origin needs a new grant) and visibility-stamped: a private→public flip suspends the grant until re-confirmed. A purge still needs the explicit --push-public opt-in.',
    default: false,
  },
  output: {
    type: 'string',
    description: 'Output format: human|json',
    default: 'human',
  },
} as const;

async function runWrite({ args }: { args: Record<string, unknown> }): Promise<void> {
  let format: ReturnType<typeof parseOutputFormat>;
  try {
    format = parseOutputFormat(args.output as string | undefined);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const required: [string, unknown][] = [
    ['--intent', args.intent],
    ['--from', args.from],
    ['--state', args.state],
    ['--next', args.next],
  ];
  const missing = required
    .filter(([, v]) => typeof v !== 'string' || v.trim().length === 0)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    writeError(`ditto handoff write: missing required ${missing.join(', ')}`);
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  let baton: Handoff;
  try {
    baton = buildBatonFromFlags(args);
  } catch (err) {
    // Bad flag shapes (zod / pair-split) are usage errors, not runtime faults.
    writeError(`ditto handoff write: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const repoRoot = await resolveRepoRootForCreate();
  let res: RefWriteResult;
  try {
    res = new HandoffRefStore(repoRoot).write(baton);
  } catch (err) {
    writeError(`ditto handoff write failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  // ac-3 write-push consent (wi_2607239vu): a public/unknown remote refuses a new
  // body unless (a) the one-shot --push-public opt-in, or (b) a standing per-
  // project consent recorded for THIS origin (normalized URL, exact match).
  // --consent-push-remote records the grant (visibility-stamped) and it applies
  // from this write onward. A grant stamped while the remote was private/internal
  // is NOT applied once the remote is public/unknown — the CLI asks for a
  // re-confirm instead (the flip must be a conscious decision). A consume's pure
  // deletion needs no consent at all: the sync core auto-exempts it.
  const visibility = resolveRepoVisibility(repoRoot);
  const originUrl = resolveOriginUrl(repoRoot);
  if (args['consent-push-remote'] === true) {
    if (originUrl === null) {
      // Loud no-op: a grant is origin-bound, so with no origin there is nothing
      // to bind it to — silently dropping the flag would look like it took.
      writeError(
        'handoff write: --consent-push-remote NOT recorded — no origin remote to bind the consent to.',
      );
    } else {
      await writeHandoffPushConsent(repoRoot, {
        origin_url: originUrl,
        visibility_at_grant: visibility === 'private' ? 'private' : 'public',
        granted_at: new Date().toISOString(),
      });
    }
  }
  let allowPublicRemote = args['push-public'] === true;
  if (!allowPublicRemote && originUrl !== null && visibility !== 'private') {
    const consent = await readHandoffPushConsent(repoRoot, originUrl);
    if (consent !== undefined) {
      const grantWasPrivate =
        consent.visibility_at_grant === 'private' || consent.visibility_at_grant === 'internal';
      if (grantWasPrivate) {
        writeError(
          `handoff sync: write-push consent for 'origin' was granted while the remote was '${consent.visibility_at_grant}' but it is now public/unknown — the consent is NOT applied until you re-confirm (re-run write with --consent-push-remote).`,
        );
      } else {
        writeError(
          "handoff: write-push consent is active for 'origin' — this write auto-pushes to the public/unknown remote under the standing per-project grant (a purge still needs the explicit --push-public opt-in).",
        );
        allowPublicRemote = true;
      }
    }
  }
  const sync = runAutoSync(repoRoot, 'write', allowPublicRemote, visibility);
  if (format === 'json') {
    writeJson({
      ref: res.ref,
      commit: res.commit,
      stem: res.stem,
      scope: baton.scope,
      sync: sync?.status ?? 'no-remote',
    });
  } else {
    writeHuman(`Wrote handoff baton ${res.stem}`);
    writeHuman(`  scope:   ${scopeLabel(baton)}`);
    writeHuman(`  ref:     ${res.ref} (commit ${res.commit} — no worktree/branch change)`);
    writeHuman(`  sync:    ${sync?.status ?? 'no origin remote — local only'}`);
    writeHuman(`  pick up: ditto handoff consume ${res.stem}`);
  }
  warnPendingUnpushed(repoRoot);
}

const handoffWrite = defineCommand({
  meta: {
    name: 'write',
    description:
      'Write a handoff baton onto the hidden ref (session scope, or --work-item), then auto-sync.',
  },
  args: writeArgs,
  run: runWrite,
});

/** One disambiguation line per pending baton — the replacement for the old `list`. */
function batonLine(b: RefBaton): string {
  return `  ${b.stem}\t[${b.handoff.scope.kind}]\t${b.handoff.created_at}\t${b.handoff.from_context}`;
}

function batonView(b: RefBaton): Record<string, unknown> {
  return {
    id: b.stem,
    kind: b.handoff.scope.kind,
    created_at: b.handoff.created_at,
    from_context: b.handoff.from_context,
  };
}

/**
 * No-id resolution shared by consume/show: exactly one pending baton → its stem;
 * zero → null after a message (clean 0-state, exit 0 by the caller falling
 * through); several → print the pending set + exit 65 (a disambiguation, never a
 * prompt). Unparsable ref entries are surfaced, not dropped.
 */
function resolvePendingStem(
  store: HandoffRefStore,
  format: 'human' | 'json',
  command: string,
): string | null {
  const { batons, failures } = store.list();
  for (const f of failures) {
    writeError(`unparsable handoff baton entry ${f.name}: ${f.error}`);
  }
  if (batons.length === 0) {
    if (format === 'json') writeJson({ pending: [] });
    else writeHuman('No pending handoff batons.');
    return null;
  }
  if (batons.length === 1) return batons[0]?.stem ?? null;
  if (format === 'json') {
    writeJson({ pending: batons.map(batonView) });
  } else {
    writeHuman(`Multiple pending handoff batons — name one (ditto handoff ${command} <id>):`);
    for (const b of batons) writeHuman(batonLine(b));
  }
  process.exit(USAGE_ERROR_EXIT);
  return null;
}

async function runConsume({ args }: { args: Record<string, unknown> }): Promise<void> {
  let format: ReturnType<typeof parseOutputFormat>;
  try {
    format = parseOutputFormat(args.output as string | undefined);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const repoRoot = await resolveRepoRootForCreate();
  // Adopt remote batons BEFORE resolution (cross-PC discovery). The observed
  // remote tip is carried into the post-CAS sync below as knownRemoteSha, so an
  // online consume runs ONE fetch, not two.
  const preFetch = runPreResolutionFetch(repoRoot);
  const store = new HandoffRefStore(repoRoot);
  let stem: string;
  if (typeof args.id === 'string' && args.id.length > 0) {
    stem = args.id;
  } else {
    const resolved = resolvePendingStem(store, format, 'consume');
    if (resolved === null) {
      warnPendingUnpushed(repoRoot);
      return;
    }
    stem = resolved;
  }
  let res: RefConsumeResult;
  try {
    res = store.consume(stem);
  } catch (err) {
    writeError(`ditto handoff consume failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  if (res.status === 'not_found') {
    writeError(`No handoff baton found for ${stem}.`);
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  if (res.status === 'already_consumed') {
    // DISTINCT from not_found: the baton existed but another session/worktree won
    // the CAS — an idempotent refusal, not an error.
    if (format === 'json') {
      writeJson({ id: stem, status: 'already_consumed' });
    } else {
      writeHuman(
        `Handoff baton ${stem} was already consumed in another session/worktree — nothing left to deliver (first-consumer-wins).`,
      );
    }
    warnPendingUnpushed(repoRoot);
    return;
  }
  // 1:1 finalization: the local CAS already gated the body; push the deletion
  // commit BEFORE emitting it so an online consume is finalized on the remote. An
  // offline/auth failure degrades to local success — the op:'consume' warning
  // states the remote baton still exists (re-consume window open). The
  // pre-resolution fetch's observation feeds knownRemoteSha ('fetched' → the
  // sha, 'remote-unborn' → null) so the sync skips its initial fetch;
  // 'fetch-failed' / no origin → undefined keeps fetch-first behavior.
  // NOTE deliberately NO grant surface here (wi_2607239vu, ac-3): a PURE deletion
  // needs none — the sync core auto-exempts it on a public/unknown remote
  // (identity-masked, a strict subset of the published remote tip) — and a
  // companion un-pushed write body must stay behind the explicit --push-public
  // opt-in, never behind a recorded standing grant.
  const visibility = resolveRepoVisibility(repoRoot);
  const knownRemoteSha =
    preFetch === null || preFetch.status === 'fetch-failed' ? undefined : preFetch.sha;
  const sync = runAutoSync(
    repoRoot,
    'consume',
    args['push-public'] === true,
    visibility,
    knownRemoteSha,
  );
  if (format === 'json') {
    writeJson({
      id: stem,
      scope: res.handoff.scope,
      deletion_commit: res.commit,
      sync: sync?.status ?? 'no-remote',
      body: res.body,
    });
  } else {
    writeHuman(`Consumed handoff baton ${stem}`);
    writeHuman(
      `  deletion commit: ${res.commit} (gone for every worktree of this repo — first-consumer-wins)`,
    );
    writeHuman('');
    writeHuman(res.body);
  }
  warnPendingUnpushed(repoRoot);
}

const handoffConsume = defineCommand({
  meta: {
    name: 'consume',
    description:
      'Consume a handoff baton: body is returned only after the deletion commit lands (first-consumer-wins). No id: auto-resolve a single pending baton, or list several (exit 65).',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Baton id (the stem the disambiguation output prints). Optional.',
      required: false,
    },
    'push-public': {
      type: 'boolean',
      description:
        'Explicit opt-in to push the FULL consume transmit set — including any companion un-pushed write body — to a public/unknown-visibility remote (pushed history cannot be un-published). A PURE deletion already propagates identity-masked without this.',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: runConsume,
});

async function runShow({ args }: { args: Record<string, unknown> }): Promise<void> {
  let format: ReturnType<typeof parseOutputFormat>;
  try {
    format = parseOutputFormat(args.output as string | undefined);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const repoRoot = await resolveRepoRootForCreate();
  // Adopt remote batons BEFORE resolution (cross-PC discovery); show still
  // pushes nothing.
  runPreResolutionFetch(repoRoot);
  const store = new HandoffRefStore(repoRoot);
  let baton: RefBaton | undefined;
  if (typeof args.id === 'string' && args.id.length > 0) {
    const { batons, failures } = store.list();
    for (const f of failures) {
      writeError(`unparsable handoff baton entry ${f.name}: ${f.error}`);
    }
    baton = batons.find((b) => b.stem === args.id);
    if (baton === undefined) {
      writeError(`No pending handoff baton ${args.id}.`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
  } else {
    const resolved = resolvePendingStem(store, format, 'show');
    if (resolved === null) {
      warnPendingUnpushed(repoRoot);
      return;
    }
    baton = store.list().batons.find((b) => b.stem === resolved);
    if (baton === undefined) {
      writeError(`No pending handoff baton ${resolved}.`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
  }
  if (format === 'json') {
    writeJson({
      id: baton.stem,
      scope: baton.handoff.scope,
      created_at: baton.handoff.created_at,
      body: baton.body,
    });
  } else {
    writeHuman(`Handoff baton ${baton.stem} (read-only — not consumed):`);
    writeHuman('');
    writeHuman(baton.body);
  }
  warnPendingUnpushed(repoRoot);
}

const handoffShow = defineCommand({
  meta: {
    name: 'show',
    description:
      'Read-only peek at a pending handoff baton (fetch-first discovery; no deletion, no marker, no push).',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Baton id (the stem the disambiguation output prints). Optional.',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: runShow,
});

async function runPurge({ args }: { args: Record<string, unknown> }): Promise<void> {
  let format: ReturnType<typeof parseOutputFormat>;
  try {
    format = parseOutputFormat(args.output as string | undefined);
  } catch (err) {
    writeError(err instanceof Error ? err.message : String(err));
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const repoRoot = await resolveRepoRootForCreate();
  // Purge exists to cut a leaked blob out of the REMOTE history — a repo with no
  // origin remote has nothing to recall from, so this is a usage error, not a no-op.
  if (!hasOriginRemote(repoRoot)) {
    writeError('handoff purge requires an origin remote');
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const result = purgeHandoffHistory(repoRoot, 'origin', {
    visibility: resolveRepoVisibility(repoRoot),
    allowPublicRemote: args['push-public'] === true,
    op: 'command',
  });
  for (const w of result.warnings) writeError(w);
  switch (result.status) {
    case 'purged':
    case 'nothing-to-purge': {
      if (format === 'json') {
        writeJson({ status: result.status, detail: result.detail, warnings: result.warnings });
      } else if (result.status === 'purged') {
        writeHuman(`Purged handoff baton ref history: ${result.detail}`);
      } else {
        writeHuman(`Nothing to purge — ${result.detail} (idempotent no-op).`);
      }
      warnPendingUnpushed(repoRoot);
      return;
    }
    case 'public-remote-refused':
      writeError(result.detail);
      writeError('handoff purge: pass --push-public to opt in for a public/unknown remote.');
      process.exit(USAGE_ERROR_EXIT);
      return;
    case 'scrub-refused':
      writeError(result.detail);
      process.exit(USAGE_ERROR_EXIT);
      return;
    case 'failed':
      writeError(result.detail);
      process.exit(1);
      return;
  }
}

const handoffPurge = defineCommand({
  meta: {
    name: 'purge',
    description:
      'Secret recall: rewrite the local baton ref history to a single root (current tip tree preserved) and lease-push it, cutting a leaked blob out of remote history. Requires an origin remote.',
  },
  args: {
    'push-public': {
      type: 'boolean',
      description:
        'Explicit opt-in to push the purged (rewritten) ref history to a public/unknown-visibility remote (the gate is fail-closed otherwise; pushed history cannot be un-published).',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: runPurge,
});

export const handoffCommand = defineCommand({
  meta: {
    name: 'handoff',
    description:
      'Handoff batons on the hidden ref (refs/ditto/handoffs). `write` commits a baton and auto-syncs; `consume [id]` delivers a body exactly once (first-consumer-wins, deletion commit); `show [id]` is a read-only peek; `purge` rewrites the ref history to a single root and lease-pushes it (secret recall). Multiple pending batons are listed by consume/show for disambiguation.',
  },
  // A PURE group: no parent `run`. citty 0.1.6 would ALSO run a parent `run` after a
  // matched subcommand (double-dispatch) and misreads a leading flag value as a
  // subcommand name — so every action is an explicit subcommand.
  subCommands: {
    write: handoffWrite,
    consume: handoffConsume,
    show: handoffShow,
    purge: handoffPurge,
  },
});
