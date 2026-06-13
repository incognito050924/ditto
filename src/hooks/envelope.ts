/**
 * Hook host envelope (dual-host M2). The hook HANDLERS are host-agnostic; only
 * the I/O envelope differs between Claude Code and Codex. This module normalizes
 * the one divergence that actually changes gate behaviour: the file-mutation
 * tool shape.
 *
 *  - Claude Code sends edits as `tool_name in {Write,Edit,MultiEdit}` with a
 *    single `tool_input.file_path`.
 *  - Codex sends edits as `tool_name="apply_patch"` with `tool_input.command`
 *    holding the patch text; the touched paths live in its `*** Add File:` /
 *    `*** Update File:` / `*** Delete File:` / `*** Move to:` headers (always
 *    relative). Without extraction those edits bypass the secret /
 *    forbidden_scope / lease gates AND the edit-evidence trail.
 *
 * `mutatedPaths(host, raw)` returns the list of paths a file-edit gate must
 * iterate. The Claude shape yields `[file_path]` (byte-identical to the old
 * single-path behaviour); the Codex apply_patch shape yields every header path.
 * A non-edit tool, or a missing field, yields `[]`.
 */

export type HookHost = 'claude-code' | 'codex';

/** apply_patch headers that name a file the patch mutates (all relative paths). */
const APPLY_PATCH_HEADER = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;

/**
 * Extract the relative paths an apply_patch command mutates, in order, from its
 * `*** Add/Update/Delete File:` and `*** Move to:` headers. A rename emits both
 * the `Update File:` (old) and `Move to:` (new) path so both are gated/recorded.
 * Duplicates are de-duplicated, preserving first-seen order.
 */
export function parseApplyPatchPaths(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of command.split('\n')) {
    const m = line.match(APPLY_PATCH_HEADER);
    if (!m) continue;
    const path = m[1];
    if (path && path.length > 0 && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * The file paths this tool call mutates, normalized per host. Claude's
 * Write/Edit/MultiEdit → `[file_path]`; Codex's apply_patch → the patch header
 * paths. Anything else → `[]`.
 */
export function mutatedPaths(host: HookHost, raw: Record<string, unknown>): string[] {
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;

  if (host === 'codex' && toolName === 'apply_patch') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
    return command ? parseApplyPatchPaths(command) : [];
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
    return filePath ? [filePath] : [];
  }

  return [];
}
