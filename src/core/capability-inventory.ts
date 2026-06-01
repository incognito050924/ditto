import type { HookEventId, HostAdapter, HostId } from './hosts';

/**
 * The cross-host required capabilities (provider parity). Every selected host
 * must back each of these with an actually-implemented loader. `hooks` is NOT
 * here: it is host-specific (codex legitimately runs no plugin hooks), so it is
 * checked per-host as declared-vs-registered drift, not as cross-host equality.
 */
export const REQUIRED_CAPABILITIES = ['instructions', 'permissions', 'mcp', 'surface'] as const;
export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

export interface HostCapabilityReport {
  host: HostId;
  capabilities: {
    hooks: HookEventId[];
    instructions: boolean;
    permissions: boolean;
    mcp: boolean;
    surface: boolean;
  };
  /** Hook events actually registered for this host (from its surface inventory). */
  hook_events: string[];
}

export type CapabilityFindingKind =
  | 'missing_required'
  | 'declared_hook_not_registered'
  | 'registered_hook_not_declared';

export interface CapabilityFinding {
  host: HostId;
  kind: CapabilityFindingKind;
  capability: string;
  message: string;
}

/**
 * Inventory each adapter's declared capabilities and check provider parity
 * fail-closed: any required capability a selected host does not support is a
 * finding (M-parity ac-3), and any drift between a host's declared hook events
 * and the events it actually registers is a finding in both directions (ac-4).
 */
export async function collectCapabilityInventory(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<{
  hosts: HostCapabilityReport[];
  finding_count: number;
  findings: CapabilityFinding[];
}> {
  const hosts: HostCapabilityReport[] = [];
  const findings: CapabilityFinding[] = [];

  for (const adapter of adapters) {
    const caps = adapter.capabilities;

    // fail-closed: every required boolean must be true for a selected host.
    for (const capability of REQUIRED_CAPABILITIES) {
      if (caps[capability] !== true) {
        findings.push({
          host: adapter.id,
          kind: 'missing_required',
          capability,
          message: `host "${adapter.id}" does not support required capability "${capability}"`,
        });
      }
    }

    // hook drift: declared hooks vs. hook events actually registered. Reuse the
    // surface inventory (single source of truth: hooks.json via scanPluginRoot);
    // do not re-read hooks.json directly.
    const inventory = await adapter.loadSurfaceInventory(repoRoot);
    const registered = inventory.localSurfaces
      .filter((entry) => entry.kind === 'hook')
      .map((entry) => entry.id);
    const declared = caps.hooks;
    const registeredSet = new Set(registered);
    const declaredSet = new Set<string>(declared);

    for (const event of declared) {
      if (!registeredSet.has(event)) {
        findings.push({
          host: adapter.id,
          kind: 'declared_hook_not_registered',
          capability: event,
          message: `host "${adapter.id}" declares hook "${event}" but it is not registered`,
        });
      }
    }
    for (const event of registered) {
      if (!declaredSet.has(event)) {
        findings.push({
          host: adapter.id,
          kind: 'registered_hook_not_declared',
          capability: event,
          message: `host "${adapter.id}" registers hook "${event}" but it is not declared`,
        });
      }
    }

    hosts.push({
      host: adapter.id,
      capabilities: {
        hooks: [...caps.hooks],
        instructions: caps.instructions,
        permissions: caps.permissions,
        mcp: caps.mcp,
        surface: caps.surface,
      },
      hook_events: registered,
    });
  }

  return { hosts, finding_count: findings.length, findings };
}
