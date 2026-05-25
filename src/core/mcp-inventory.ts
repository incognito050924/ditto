import type { HostAdapter, McpInventory, McpServerEntry } from './hosts';

export interface McpReport {
  status: 'ok' | 'unverified';
  servers: McpServerEntry[];
  unavailable: McpInventory['unavailable'];
  unavailable_reason?: string;
}

export async function collectMcpInventory(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<McpReport> {
  const inventories = await Promise.all(
    adapters.map((adapter) => adapter.loadMcpServers(repoRoot)),
  );
  const servers = inventories.flatMap((inv) => inv.servers);
  const unavailable = inventories.flatMap((inv) => inv.unavailable);
  const status = servers.length > 0 ? 'ok' : 'unverified';
  return {
    status,
    servers,
    unavailable,
    ...(status === 'unverified'
      ? {
          unavailable_reason: unavailable
            .map((item) => `${item.source_file}: ${item.reason}`)
            .join('; '),
        }
      : {}),
  };
}
