import type { HostAdapter, HostId, PermissionInventory, PermissionRiskLabel } from './hosts';
import { asRecord, asStringArray } from './hosts/shared';

export interface PermissionFinding {
  host: HostId;
  source_file: string;
  label: PermissionRiskLabel | 'missing' | 'unverified';
  message: string;
}

const WILDCARD_ALLOW: ReadonlySet<string> = new Set(['*', 'Bash', 'Bash(*)', 'WebFetch(*)']);

const DESTRUCTIVE_ALLOW_PATTERNS: ReadonlyArray<RegExp> = [
  /^Write\(/,
  /^Bash\(rm\b/,
  /^Bash\(sudo\b/,
];

export function classifyAllowEntry(entry: string): PermissionRiskLabel[] {
  if (WILDCARD_ALLOW.has(entry)) return ['dangerous_mode', 'approval_bypass'];
  if (DESTRUCTIVE_ALLOW_PATTERNS.some((re) => re.test(entry))) return ['write_outside_workspace'];
  return [];
}

export function findingsFromPermissionInventory(inv: PermissionInventory): PermissionFinding[] {
  if (inv.status === 'missing') {
    return [
      {
        host: inv.host,
        source_file: inv.source_file,
        label: 'missing',
        message: inv.unavailable_reason ?? 'permission config not found',
      },
    ];
  }
  if (inv.status === 'unverified') {
    return [
      {
        host: inv.host,
        source_file: inv.source_file,
        label: 'unverified',
        message: inv.unavailable_reason ?? 'permission config could not be verified',
      },
    ];
  }

  const findings: PermissionFinding[] = [];
  if (inv.host === 'codex') {
    if (inv.raw.sandbox_mode === 'danger-full-access') {
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'dangerous_mode',
        message: 'codex sandbox_mode=danger-full-access',
      });
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'write_outside_workspace',
        message: 'codex danger-full-access can write outside the workspace',
      });
    }
    if (inv.raw.network_access === true) {
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'network_on',
        message: 'codex network_access=true',
      });
    }
    const sandboxWorkspaceWrite = asRecord(inv.raw.sandbox_workspace_write);
    if (sandboxWorkspaceWrite?.network_access === true) {
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'network_on',
        message: 'codex [sandbox_workspace_write].network_access=true',
      });
    }
    if (inv.raw.approval_policy === 'never') {
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'approval_bypass',
        message: 'codex approval_policy=never',
      });
    }
  } else {
    if (inv.raw.defaultMode === 'bypassPermissions') {
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'dangerous_mode',
        message: 'claude-code defaultMode=bypassPermissions',
      });
      findings.push({
        host: inv.host,
        source_file: inv.source_file,
        label: 'approval_bypass',
        message: 'claude-code bypasses permission prompts',
      });
    }
    const permissions = asRecord(inv.raw.permissions);
    const allowList = asStringArray(permissions?.allow);
    if (allowList) {
      const seen = new Set<PermissionRiskLabel>();
      for (const entry of allowList) {
        for (const label of classifyAllowEntry(entry)) {
          if (seen.has(label)) continue;
          seen.add(label);
          findings.push({
            host: inv.host,
            source_file: inv.source_file,
            label,
            message:
              label === 'write_outside_workspace'
                ? `claude-code permissions.allow contains destructive pattern: ${entry}`
                : `claude-code permissions.allow contains wildcard entry: ${entry}`,
          });
        }
      }
    }
  }
  return findings;
}

export async function collectPermissionFindings(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<PermissionFinding[]> {
  const inventoryArrays = await Promise.all(
    adapters.map((adapter) => adapter.loadPermissions(repoRoot)),
  );
  return inventoryArrays.flat().flatMap(findingsFromPermissionInventory);
}
