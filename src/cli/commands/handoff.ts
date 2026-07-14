import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  type ActiveHandoff,
  HandoffStore,
  type RemoteHandoff,
  buildSessionHandoff,
  scopeKey,
} from '~/core/handoff-store';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto handoff` (wi_260714xpw) — the user-facing handoff producer + EXPLICIT-PULL
 * discovery/consume surface. It is a thin shell over `HandoffStore`:
 *
 *  - `ditto handoff write` with NO work item writes a SESSION/author-scope handoff
 *    (`buildSessionHandoff` + the store's LOCAL `write`). The work_item producer stays
 *    `ditto work handoff <id>` (preserved) — this fills the no-WI gap (ac-2).
 *  - `ditto handoff write --remote` COMMITS the same handoff to the work branch via the
 *    store's `writeRemote` (git-tracked `.ditto/handoff/<stem>.md`, delivered on
 *    checkout, NEVER pushed) — the committed-remote tier's reachable producer (ac-4).
 *  - `ditto handoff list` discovers pending handoffs from BOTH tiers — local
 *    (`listActiveDetailed`) and committed-remote (`listRemote`) — plus any unparsable
 *    files from either (never a silent drop, ac-3).
 *  - `ditto handoff consume <id>` SOFT-consumes: it loads the body on-demand and records
 *    the per-recipient consumed-marker WITHOUT moving/deleting the file (ac-6, ac-7). It
 *    routes a remote id (looked up in `listRemote`) to `consumeRemote`, else `consumeFor`.
 *  - `ditto handoff show <id>` is a read-only view (no marker).
 *
 * Discovery + consumption are EXPLICIT PULL only: nothing here (and no hook) auto-injects
 * a body or emits a notification (ac-9 is a sibling's AC — this surface never auto-reads).
 *
 * The `<id>` a caller passes to `consume`/`show` is the handoff FILE STEM that `list`
 * prints (a work item's `<wi>`, or a session's `session__<sid>`). `getActive`/`consumeFor`
 * resolve `<stem>.md` uniformly, so ONE id shape drives both scopes through the public
 * store API — no routing logic is reimplemented here.
 */

/** The file-stem identity `list` prints and `consume`/`show` accept (basename minus `.md`). */
function stemOf(relPath: string): string {
  return basename(relPath).replace(/\.md$/, '');
}

/** A safe generated session id when the caller does not pass `--session`. */
function generateSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
  return `sess-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** The shared `--*` args for the session producer (parent `run` and the `write` alias). */
const writeArgs = {
  session: {
    type: 'string',
    description:
      'Session id this handoff resumes (session/author scope). Omit to generate a safe one.',
    required: false,
  },
  intent: {
    type: 'string',
    description: 'Original user intent (required — there is no work item to derive it from).',
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
  remote: {
    type: 'boolean',
    description:
      'Commit the handoff to the work branch (.ditto/handoff/, git-tracked, delivered to a fetch/checkout recipient) instead of the gitignored LOCAL store. Never pushes (push is a separate user-gated act).',
    default: false,
  },
  output: {
    type: 'string',
    description: 'Output format: human|json',
    default: 'human',
  },
} as const;

/**
 * Write a SESSION-scope handoff to the LOCAL store. Session scope has no work item, so
 * the original intent + context fields are supplied directly and are REQUIRED (the
 * schema mins them at 1). A missing required field is a usage error (exit 65), not a
 * raw zod stack.
 */
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
    writeError(`ditto handoff: missing required ${missing.join(', ')} for a session handoff`);
    process.exit(USAGE_ERROR_EXIT);
    return;
  }
  const sessionId =
    typeof args.session === 'string' && args.session.trim().length > 0
      ? args.session
      : generateSessionId();
  const repoRoot = await resolveRepoRootForCreate();
  try {
    const handoff = buildSessionHandoff({
      sessionId,
      originalIntent: args.intent as string,
      fromContext: args.from as string,
      currentState: args.state as string,
      nextFirstCheck: args.next as string,
      ...(typeof args.autopilot === 'string' && args.autopilot.length > 0
        ? { autopilotId: args.autopilot }
        : {}),
    });
    const store = new HandoffStore(repoRoot);
    if (args.remote === true) {
      // Committed-remote tier: the store commits the per-scope file to the work branch
      // (branch-target verified, body scrubbed, NO push). A refusal (wrong branch /
      // detached / gitignored) throws HandoffRemoteWriteError → surfaced below.
      const res = await store.writeRemote(handoff);
      if (format === 'json') {
        writeJson({
          remote: true,
          path: res.rel,
          branch: res.branch,
          commit: res.commit,
          author: res.author,
          stem: res.stem,
          scope: handoff.scope,
        });
      } else {
        writeHuman(`Committed remote handoff ${res.stem}`);
        writeHuman(`  scope:   session (${sessionId})`);
        writeHuman(`  branch:  ${res.branch}`);
        writeHuman(`  path:    ${res.rel} (git-tracked, delivered on checkout — NOT pushed)`);
        writeHuman(`  pick up: ditto handoff list  →  ditto handoff consume ${res.stem}`);
      }
      return;
    }
    const rel = await store.write(handoff);
    if (format === 'json') {
      writeJson({ path: rel, scope: handoff.scope, stem: stemOf(rel) });
    } else {
      writeHuman(`Wrote session handoff ${stemOf(rel)}`);
      writeHuman(`  scope:   session (${sessionId})`);
      writeHuman(`  path:    ${rel}`);
      writeHuman(`  pick up: ditto handoff list  →  ditto handoff consume ${stemOf(rel)}`);
    }
  } catch (err) {
    // buildSessionHandoff (zod) rejects an empty/invalid field or a malformed
    // autopilot id — a usage error, not a runtime fault.
    writeError(`ditto handoff write failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(USAGE_ERROR_EXIT);
  }
}

const handoffWrite = defineCommand({
  meta: {
    name: 'write',
    description: 'Write a session/author-scope handoff (no work item).',
  },
  args: writeArgs,
  run: runWrite,
});

/** JSON-friendly shape for a listed active handoff — the stem is the consume/show id. */
function activeView(a: ActiveHandoff): Record<string, unknown> {
  return {
    id: stemOf(a.path),
    kind: a.handoff.scope.kind,
    scope_key: scopeKey(a.handoff.scope),
    created_at: a.handoff.created_at,
    from_context: a.handoff.from_context,
    ...(a.handoff.autopilot_id ? { autopilot_id: a.handoff.autopilot_id } : {}),
    path: a.path,
  };
}

/**
 * JSON-friendly shape for a committed-remote handoff. Its id is the filename STEM
 * (`consume`/`show` accept it); `tier: 'remote'` distinguishes it from the local set.
 */
function remoteView(r: RemoteHandoff): Record<string, unknown> {
  return {
    id: r.stem,
    tier: 'remote',
    kind: r.handoff.scope.kind,
    scope_key: scopeKey(r.handoff.scope),
    created_at: r.handoff.created_at,
    from_context: r.handoff.from_context,
    ...(r.handoff.autopilot_id ? { autopilot_id: r.handoff.autopilot_id } : {}),
    path: r.path,
  };
}

const handoffList = defineCommand({
  meta: {
    name: 'list',
    description:
      'Discover pending LOCAL handoffs (explicit pull). Shows the active set AND any files that failed to parse — never silently dropped.',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new HandoffStore(repoRoot);
    const { active, failures } = await store.listActiveDetailed();
    // ALSO surface committed-remote handoffs so a resuming agent discovers the ones a
    // fetch/checkout delivered — otherwise the remote tier is unreachable. Parse failures
    // from BOTH tiers are surfaced (ac-3: never a silent drop).
    const { handoffs: remote, failures: remoteFailures } = await store.listRemote();
    const allFailures = [...failures, ...remoteFailures];
    if (format === 'json') {
      writeJson({
        active: active.map(activeView),
        remote: remote.map(remoteView),
        failures: allFailures,
      });
      return;
    }
    if (active.length === 0 && remote.length === 0) {
      writeHuman('No pending handoffs.');
    }
    if (active.length > 0) {
      writeHuman('Pending LOCAL handoffs (consume by id):');
      for (const a of active) {
        writeHuman(
          `  ${stemOf(a.path)}\t[${a.handoff.scope.kind}]\t${a.handoff.created_at}\t${a.handoff.from_context}`,
        );
      }
    }
    if (remote.length > 0) {
      writeHuman('Committed REMOTE handoffs (consume by id):');
      for (const r of remote) {
        writeHuman(
          `  ${r.stem}\t[${r.handoff.scope.kind}]\t${r.handoff.created_at}\t${r.handoff.from_context}\t(remote)`,
        );
      }
    }
    if (allFailures.length > 0) {
      writeHuman('Unparsable handoff files (surfaced, not dropped):');
      for (const f of allFailures) {
        writeHuman(`  ! ${f.path}\t(${f.scope})\t${f.error}`);
      }
    }
  },
});

const handoffConsume = defineCommand({
  meta: {
    name: 'consume',
    description:
      'Soft-consume a handoff by id: load the body on-demand + record a consumed-marker. Does NOT move/delete the file (age-sweep is the sole hard cleanup).',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Handoff id (the stem `list` prints: a work item `<wi>`, or `session__<sid>`).',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const store = new HandoffStore(repoRoot);
      // Route by LOOKING UP the id, not by guessing its shape: a committed-remote handoff
      // is identified by its filename stem in THIS recipient's pending remote set. Found →
      // consume the remote tier (per-recipient LOCAL marker, no git delete/commit/push).
      // Not found → the id is a LOCAL handoff, consumed through consumeFor. (An id already
      // consumed remotely is absent from listRemote and falls through to the local path,
      // which reports "no active handoff" — nothing to re-consume.)
      const { handoffs: remote } = await store.listRemote();
      const remoteMatch = remote.find((r) => r.stem === args.id);
      if (remoteMatch) {
        const consumed = await store.consumeRemote(remoteMatch);
        if (format === 'json') {
          writeJson({
            id: consumed.stem,
            tier: 'remote',
            scope: consumed.handoff.scope,
            path: consumed.path,
            body: consumed.body,
          });
        } else {
          writeHuman(`Handoff ${consumed.stem} (${consumed.path}, remote):\n`);
          writeHuman(consumed.body);
        }
        return;
      }
      const consumed = await store.consumeFor(args.id);
      if (!consumed) {
        if (format === 'json') writeJson({ id: args.id, handoff: null });
        else writeHuman(`No active handoff for ${args.id}.`);
        return;
      }
      if (format === 'json') {
        writeJson({
          id: stemOf(consumed.path),
          scope: consumed.handoff.scope,
          path: consumed.path,
          body: consumed.body,
        });
      } else {
        writeHuman(`Handoff ${stemOf(consumed.path)} (${consumed.path}):\n`);
        writeHuman(consumed.body);
      }
    } catch (err) {
      writeError(
        `ditto handoff consume failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const handoffShow = defineCommand({
  meta: {
    name: 'show',
    description:
      'Read-only view of an active handoff by id (no consumed-marker, does not consume).',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Handoff id (the stem `list` prints).',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const found = await new HandoffStore(repoRoot).getActive(args.id);
    if (!found) {
      if (format === 'json') writeJson({ id: args.id, handoff: null });
      else writeHuman(`No active handoff for ${args.id}.`);
      return;
    }
    if (format === 'json') {
      writeJson({
        id: stemOf(found.path),
        scope: found.handoff.scope,
        path: found.path,
        body: found.body,
      });
    } else {
      writeHuman(`Handoff ${stemOf(found.path)} (${found.path}):\n`);
      writeHuman(found.body);
    }
  },
});

export const handoffCommand = defineCommand({
  meta: {
    name: 'handoff',
    description:
      'Write / discover / consume handoffs. `write` produces a session-scope handoff (no work item); `list` discovers pending ones (explicit pull); `consume <id>` loads a body on-demand; `show <id>` is read-only. `ditto work handoff <id>` remains the work-item producer.',
  },
  // A PURE group: no parent `run`. citty 0.1.6 would ALSO run a parent `run` after a
  // matched subcommand (double-dispatch) and misreads a leading flag value as a
  // subcommand name — so the session producer is the explicit `write` subcommand, not a
  // bare `ditto handoff <flags>`.
  subCommands: {
    write: handoffWrite,
    list: handoffList,
    consume: handoffConsume,
    show: handoffShow,
  },
});
