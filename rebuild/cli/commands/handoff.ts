import { randomBytes } from 'node:crypto';

import { defineCommand } from 'citty';

import {
  BatonExistsError,
  UnsafeBatonNameError,
  consumeHandoff,
  writeHandoff,
} from '../../handoff/ref-store';
import { pushHandoffs } from '../../handoff/ref-sync';
import { findRepoRoot } from '../../util/fs';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto handoff` over the rebuilt hidden-ref store (`refs/ditto/handoffs`). A
 * handoff is a user-initiated 1:1 ephemeral baton that lives as a commit on the
 * hidden ref — never a working-tree file or a branch commit:
 *
 *  - `write` composes a markdown body from the structured flags (required
 *    --intent/--from/--state/--next plus the rich repeatable flags) and commits
 *    it under the baton name (--id, or a generated safe stem) via `writeHandoff`.
 *  - `consume <id>` returns the body EXACTLY once and deletes the baton
 *    (`consumeHandoff`); an absent baton is a clean non-zero "no such handoff".
 *  - `push` publishes the hidden ref to a remote (`pushHandoffs`, refs/ditto/*
 *    only).
 *
 * The body composition is CLI-layer formatting only — the rebuilt `writeHandoff`
 * takes a raw body string and carries no schema, so the markdown layout here just
 * mirrors the old structured fields closely enough to stay useful to the reader.
 * The old command's `show`/`purge` verbs are intentionally absent: the rebuilt
 * store backs neither a peek nor a history-rewrite yet.
 */

/** A flag value that cannot be turned into a usable handoff — exit 65, not a stack. */
class HandoffUsageError extends Error {}

/** A safe generated baton name when --id is omitted (charset: [A-Za-z0-9._-], no dot lead). */
function generateBatonName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
  return `handoff-${stamp}-${randomBytes(3).toString('hex')}`;
}

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

/** Append a markdown bullet section only when the list is non-empty. */
function bulletSection(lines: string[], heading: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${heading}`);
  for (const item of items) lines.push(`- ${item}`);
  lines.push('');
}

/**
 * Compose the handoff markdown body from the write flags. CLI-layer formatting
 * (no engine dependency): mirrors the old structured Handoff fields so the next
 * agent reads the same intent/state/decisions the old command carried. Throws
 * HandoffUsageError on a bad pair flag.
 */
function composeBody(name: string, args: Record<string, unknown>): string {
  const workItem = args['work-item'];
  const scopeLine =
    typeof workItem === 'string' && workItem.trim().length > 0
      ? `work item ${workItem.trim()}`
      : `session (${
          typeof args.session === 'string' && args.session.trim().length > 0
            ? args.session.trim()
            : generateBatonName()
        })`;

  const decisions = toList(args.decision, '--decision');
  const critical = toList(args.critical, '--critical').map((raw) => {
    const [decision, rationale] = splitPair(raw, '--critical');
    return `${decision} — ${rationale}`;
  });
  const risks = toList(args.risk, '--risk').map((raw) => {
    const [risk, why] = splitPair(raw, '--risk');
    return `${risk} — ${why}`;
  });
  const changed = toList(args.changed, '--changed');
  const evidence = toList(args.evidence, '--evidence');
  const open = toList(args.open, '--open');
  const forbid = toList(args.forbid, '--forbid');

  const lines: string[] = [];
  lines.push(`# Handoff ${name}`);
  lines.push('');
  lines.push(`- scope: ${scopeLine}`);
  if (typeof args.autopilot === 'string' && args.autopilot.trim().length > 0) {
    lines.push(`- autopilot: ${args.autopilot.trim()}`);
  }
  lines.push(`- created_at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## From');
  lines.push(String(args.from));
  lines.push('');
  lines.push('## Original intent');
  lines.push(String(args.intent));
  lines.push('');
  lines.push('## Current state');
  lines.push(String(args.state));
  lines.push('');
  lines.push('## Next first check');
  lines.push(String(args.next));
  lines.push('');
  bulletSection(lines, 'Decisions made', decisions);
  bulletSection(lines, 'Critical decisions', critical);
  bulletSection(lines, 'Irreversible risks', risks);
  bulletSection(lines, 'Changed files', changed);
  bulletSection(lines, 'Evidence', evidence);
  bulletSection(lines, 'Open threads', open);
  bulletSection(lines, 'Forbidden scope creep', forbid);
  return `${lines.join('\n').trimEnd()}\n`;
}

const handoffWrite = defineCommand({
  meta: {
    name: 'write',
    description:
      'Compose a handoff from structured flags and commit it onto the hidden ref (session scope, or --work-item).',
  },
  args: {
    id: {
      type: 'string',
      description: 'Baton name for consume [A-Za-z0-9._-]. Omit to generate a safe one.',
      required: false,
    },
    'work-item': {
      type: 'string',
      description: 'Scope the handoff to a work item (else session scope with a generated id).',
      required: false,
    },
    session: {
      type: 'string',
      description: 'Explicit session id for a session-scope handoff. Omit to generate a safe one.',
      required: false,
    },
    intent: { type: 'string', description: 'Original user intent (required).', required: false },
    from: {
      type: 'string',
      description: 'Where this handoff is written from: session/agent and its state (required).',
      required: false,
    },
    state: { type: 'string', description: 'Where things stand now (required).', required: false },
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
      description: 'A decision made this session (repeatable).',
      required: false,
    },
    critical: {
      type: 'string',
      description: 'A non-rederivable decision as "decision::rationale" (repeatable).',
      required: false,
    },
    risk: {
      type: 'string',
      description: 'An irreversible risk as "risk::why" (repeatable).',
      required: false,
    },
    open: {
      type: 'string',
      description: 'An open thread the next session must know (repeatable).',
      required: false,
    },
    forbid: {
      type: 'string',
      description: 'A forbidden scope creep (repeatable).',
      required: false,
    },
    evidence: {
      type: 'string',
      description: 'An inline evidence note (repeatable).',
      required: false,
    },
    changed: {
      type: 'string',
      description: 'A changed repo-relative file path (repeatable).',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output as string | undefined);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
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
    }
    const name =
      typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : generateBatonName();
    let body: string;
    try {
      body = composeBody(name, args as Record<string, unknown>);
    } catch (err) {
      // Bad pair-flag shapes are usage errors, not runtime faults.
      writeError(`ditto handoff write: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const repoRoot = await findRepoRoot();
    let commit: string;
    try {
      const res = await writeHandoff(repoRoot, name, body);
      commit = res.commit;
    } catch (err) {
      // A duplicate baton or an unsafe name is a usage error (the caller fixes the
      // flag); anything else is a runtime fault.
      if (err instanceof BatonExistsError || err instanceof UnsafeBatonNameError) {
        writeError(`ditto handoff write: ${err.message}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      writeError(`ditto handoff write failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
    if (format === 'json') {
      writeJson({ id: name, commit });
    } else {
      writeHuman(`Wrote handoff ${name}`);
      writeHuman(`  commit:  ${commit} (on refs/ditto/handoffs — no worktree/branch change)`);
      writeHuman(`  pick up: ditto handoff consume ${name}`);
    }
  },
});

const handoffConsume = defineCommand({
  meta: {
    name: 'consume',
    description:
      'Consume a handoff: the body is returned exactly once and the baton is deleted (first-consumer-wins).',
  },
  args: {
    id: { type: 'positional', description: 'Baton name to consume.' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output as string | undefined);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const repoRoot = await findRepoRoot();
    let body: string | null;
    try {
      body = await consumeHandoff(repoRoot, args.id);
    } catch (err) {
      // An unsafe name is a usage error; anything else is a runtime fault.
      if (err instanceof UnsafeBatonNameError) {
        writeError(`ditto handoff consume: ${err.message}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      writeError(
        `ditto handoff consume failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
    if (body === null) {
      writeError(`No handoff found for ${args.id}.`);
      process.exit(USAGE_ERROR_EXIT);
    }
    // The body is delivered exactly once — the baton is now gone.
    if (format === 'json') {
      writeJson({ id: args.id, body });
    } else {
      writeHuman(body);
    }
  },
});

const handoffPush = defineCommand({
  meta: {
    name: 'push',
    description: 'Publish the hidden handoff ref (refs/ditto/* only) to a remote.',
  },
  args: {
    remote: { type: 'string', description: 'Remote to push to.', default: 'origin' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output as string | undefined);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const remote = typeof args.remote === 'string' && args.remote.length > 0 ? args.remote : 'origin';
    const repoRoot = await findRepoRoot();
    try {
      await pushHandoffs(repoRoot, remote);
    } catch (err) {
      writeError(`ditto handoff push failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
    if (format === 'json') {
      writeJson({ remote, pushed: true });
    } else {
      writeHuman(`Pushed refs/ditto/handoffs → ${remote}.`);
    }
  },
});

export const handoffCommand = defineCommand({
  meta: {
    name: 'handoff',
    description:
      'Handoff batons on the hidden ref (refs/ditto/handoffs). `write` composes a body from structured flags and commits it; `consume <id>` delivers a body exactly once (deletion); `push` publishes the ref to a remote.',
  },
  subCommands: {
    write: handoffWrite,
    consume: handoffConsume,
    push: handoffPush,
  },
});
