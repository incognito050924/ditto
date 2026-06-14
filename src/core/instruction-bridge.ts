import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  type BuiltinHostId,
  type HostAdapter,
  type InstructionSurface,
  getHostAdapter,
  listHostAdapters,
} from './hosts';

export const MANAGED_START_RE =
  /<!--\s*ditto:managed:start\s+source=([^\s]+)\s+sha256=([a-f0-9]{64})\s*-->/;
export const MANAGED_END = '<!-- ditto:managed:end -->';
const MANAGED_BLOCK_RE_G =
  /<!--\s*ditto:managed:start\s+source=([^\s]+)\s+sha256=([a-f0-9]{64})\s*-->\n?([\s\S]*?)<!--\s*ditto:managed:end\s*-->/g;

export type InstructionFindingKind =
  | 'source_missing'
  | 'marker_in_source'
  | 'projection_missing'
  | 'marker_missing'
  | 'multiple_markers'
  | 'source_mismatch'
  | 'sha256_mismatch'
  | 'content_mismatch';

export interface InstructionFinding {
  host: 'codex' | 'claude-code';
  path: string;
  kind: InstructionFindingKind;
  message: string;
  markerSource?: string;
  markerSha256?: string;
  actualSha256?: string;
  sourceSha256?: string;
}

export interface InstructionHostResult {
  host: BuiltinHostId;
  path: string;
  status: 'ok' | 'drift';
  markerSource?: string;
  markerSha256?: string;
  actualSha256?: string;
  sourceSha256?: string;
  findings: InstructionFinding[];
}

export interface InstructionReport {
  findings: InstructionFinding[];
  results: InstructionHostResult[];
  sourceSha256: string | null;
}

export interface InstructionSource {
  path: string;
  content: string;
  normalizedSha256: string;
}

export type ProjectionLoadResult =
  | {
      kind: 'ok';
      path: string;
      content: string;
      managedBlock: string;
      markerSource: string;
      markerSha256: string;
      actualSha256: string;
      startIndex: number;
      endIndex: number;
    }
  | { kind: 'missing'; path: string }
  | { kind: 'no_marker'; path: string; content: string }
  | { kind: 'multiple_markers'; path: string; content: string; count: number };

export function normalizeInstructionText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

export function normalizedSha256(text: string): string {
  return createHash('sha256').update(normalizeInstructionText(text)).digest('hex');
}

function sourceFromSurface(
  surface: InstructionSurface,
): InstructionSource | { kind: 'missing'; path: string } {
  if (surface.role !== 'source') {
    return { kind: 'missing', path: join(surface.path, '..', 'AGENTS.md') };
  }
  if (!surface.exists || surface.content === undefined)
    return { kind: 'missing', path: surface.path };
  return {
    path: surface.path,
    content: surface.content,
    normalizedSha256: normalizedSha256(surface.content),
  };
}

function projectionFromSurface(surface: InstructionSurface): ProjectionLoadResult {
  if (surface.role !== 'projection' || !surface.exists || surface.content === undefined) {
    return { kind: 'missing', path: surface.path };
  }
  const content = surface.content;
  const matches = [...content.matchAll(MANAGED_BLOCK_RE_G)];
  if (matches.length === 0) return { kind: 'no_marker', path: surface.path, content };
  if (matches.length > 1)
    return { kind: 'multiple_markers', path: surface.path, content, count: matches.length };
  const match = matches[0];
  if (!match || match.index === undefined)
    return { kind: 'no_marker', path: surface.path, content };
  const markerSource = match[1] ?? '';
  const markerSha256 = match[2] ?? '';
  const managedBlock = match[3] ?? '';
  return {
    kind: 'ok',
    path: surface.path,
    content,
    managedBlock,
    markerSource,
    markerSha256,
    actualSha256: normalizedSha256(managedBlock),
    startIndex: match.index,
    endIndex: match.index + match[0].length,
  };
}

export async function loadSource(
  repoRoot: string,
): Promise<InstructionSource | { kind: 'missing'; path: string }> {
  return sourceFromSurface(await getHostAdapter('codex').loadInstructions(repoRoot));
}

export async function loadProjection(repoRoot: string): Promise<ProjectionLoadResult> {
  return projectionFromSurface(await getHostAdapter('claude-code').loadInstructions(repoRoot));
}

export function sourceHasManagedMarker(content: string): boolean {
  return content.includes('ditto:managed:start') || content.includes('ditto:managed:end');
}

export function checkCodexInstructions(
  source: InstructionSource | { kind: 'missing'; path: string },
): InstructionFinding[] {
  if ('kind' in source) {
    return [
      {
        host: 'codex',
        path: source.path,
        kind: 'source_missing',
        message: 'AGENTS.md is missing',
      },
    ];
  }
  const markerCount = [...source.content.matchAll(MANAGED_BLOCK_RE_G)].length;
  if (markerCount > 1) {
    return [
      {
        host: 'codex',
        path: source.path,
        kind: 'multiple_markers',
        message: `AGENTS.md contains ${markerCount} ditto managed blocks; expected at most 1`,
        sourceSha256: source.normalizedSha256,
      },
    ];
  }
  return [];
}

export function compareClaudeProjection(
  source: InstructionSource | { kind: 'missing'; path: string },
  projection: ProjectionLoadResult,
): InstructionFinding[] {
  if ('kind' in source) {
    return [
      {
        host: 'claude-code',
        path: source.path,
        kind: 'source_missing',
        message: 'AGENTS.md is missing',
      },
    ];
  }
  if (projection.kind === 'missing') {
    return [
      {
        host: 'claude-code',
        path: projection.path,
        kind: 'projection_missing',
        message: 'CLAUDE.md projection is missing',
        sourceSha256: source.normalizedSha256,
      },
    ];
  }
  if (projection.kind === 'no_marker') {
    return [
      {
        host: 'claude-code',
        path: projection.path,
        kind: 'marker_missing',
        message: 'CLAUDE.md does not contain a ditto managed block',
        sourceSha256: source.normalizedSha256,
      },
    ];
  }
  if (projection.kind === 'multiple_markers') {
    return [
      {
        host: 'claude-code',
        path: projection.path,
        kind: 'multiple_markers',
        message: `CLAUDE.md contains ${projection.count} ditto managed blocks; expected exactly 1`,
        sourceSha256: source.normalizedSha256,
      },
    ];
  }

  const findings: InstructionFinding[] = [];
  if (projection.markerSource !== 'AGENTS.md') {
    findings.push({
      host: 'claude-code',
      path: projection.path,
      kind: 'source_mismatch',
      message: `managed block source is ${projection.markerSource}, expected AGENTS.md`,
      markerSource: projection.markerSource,
      markerSha256: projection.markerSha256,
      actualSha256: projection.actualSha256,
      sourceSha256: source.normalizedSha256,
    });
  }
  if (projection.markerSha256 !== source.normalizedSha256) {
    findings.push({
      host: 'claude-code',
      path: projection.path,
      kind: 'sha256_mismatch',
      message: 'managed block marker sha256 does not match AGENTS.md',
      markerSource: projection.markerSource,
      markerSha256: projection.markerSha256,
      actualSha256: projection.actualSha256,
      sourceSha256: source.normalizedSha256,
    });
  }
  if (projection.actualSha256 !== source.normalizedSha256) {
    findings.push({
      host: 'claude-code',
      path: projection.path,
      kind: 'content_mismatch',
      message: 'managed block content does not match AGENTS.md',
      markerSource: projection.markerSource,
      markerSha256: projection.markerSha256,
      actualSha256: projection.actualSha256,
      sourceSha256: source.normalizedSha256,
    });
  }
  return findings;
}

function resultStatus(findings: InstructionFinding[]): 'ok' | 'drift' {
  return findings.length === 0 ? 'ok' : 'drift';
}

function codexInstructionResult(
  source: InstructionSource | { kind: 'missing'; path: string },
): InstructionHostResult {
  const findings = checkCodexInstructions(source);
  return {
    host: 'codex',
    path: source.path,
    status: resultStatus(findings),
    ...('normalizedSha256' in source ? { sourceSha256: source.normalizedSha256 } : {}),
    findings,
  };
}

function claudeInstructionResult(
  source: InstructionSource | { kind: 'missing'; path: string },
  projection: ProjectionLoadResult,
): InstructionHostResult {
  const findings = compareClaudeProjection(source, projection);
  const sourceSha256 = 'normalizedSha256' in source ? source.normalizedSha256 : undefined;
  return {
    host: 'claude-code',
    path: projection.path,
    status: resultStatus(findings),
    ...(projection.kind === 'ok'
      ? {
          markerSource: projection.markerSource,
          markerSha256: projection.markerSha256,
          actualSha256: projection.actualSha256,
        }
      : {}),
    ...(sourceSha256 ? { sourceSha256 } : {}),
    findings,
  };
}

export async function checkInstructionsForHosts(
  hosts: BuiltinHostId[],
  repoRoot: string,
): Promise<InstructionReport> {
  return checkInstructionsForAdapters(
    hosts.map((host) => getHostAdapter(host)),
    repoRoot,
  );
}

export async function checkInstructionsForAdapters(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<InstructionReport> {
  const surfaces = await Promise.all(adapters.map((adapter) => adapter.loadInstructions(repoRoot)));
  let sourceSurface = surfaces.find((surface) => surface.role === 'source');
  if (!sourceSurface) {
    const registeredAdapters = listHostAdapters().filter((adapter) => !adapters.includes(adapter));
    const registered = await Promise.all(
      registeredAdapters.map((adapter) => adapter.loadInstructions(repoRoot)),
    );
    sourceSurface = registered.find((surface) => surface.role === 'source');
  }
  if (!sourceSurface) {
    const sourcePath = join(repoRoot, 'AGENTS.md');
    sourceSurface = { role: 'source', host: 'codex', path: sourcePath, exists: false };
  }
  const source = sourceFromSurface(sourceSurface);
  const results: InstructionHostResult[] = [];
  for (const surface of surfaces) {
    if (surface.host === 'codex' && surface.role === 'source') {
      results.push(codexInstructionResult(source));
    }
    if (surface.host === 'claude-code' && surface.role === 'projection') {
      results.push(claudeInstructionResult(source, projectionFromSurface(surface)));
    }
  }
  const findings = results.flatMap((result) => result.findings);
  return {
    findings,
    results,
    sourceSha256: 'normalizedSha256' in source ? source.normalizedSha256 : null,
  };
}
