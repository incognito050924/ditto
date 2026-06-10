/**
 * Memory subsystem stores (increment #2) — design §10-1/§10-2.
 *
 * Two tiers per §7/§10-1:
 *   - SoT (git-tracked, per-entity JSON) under `dittoDir(root)/memory/`:
 *     sources/ and events/. Events are immutable per-entity files; "append-only"
 *     is achieved by never mutating a file (open flag 'wx' fails if it exists,
 *     closing the TOCTOU window) and superseding via a new event (§10-2 F2).
 *   - Derived (gitignored, regenerable) under `localDir(root,'memory',…)`:
 *     ir/graph-ir.json and projections/. Whole-file replacement.
 *
 * Stores mirror the work-item-store.ts skeleton: `constructor(repoRoot)`,
 * private path methods composing dittoDir/localDir, IO via fs.ts
 * (readJson/writeJson/ensureDir).
 */
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type MemoryEvent, memoryEvent } from '~/schemas/memory-event';
import { type MemoryGraphIr, memoryGraphIr } from '~/schemas/memory-graph-ir';
import {
  type MemoryProjectionManifest,
  memoryProjectionManifest,
} from '~/schemas/memory-projection-manifest';
import { type MemorySource, memorySource } from '~/schemas/memory-source';
import { dittoDir, localDir } from './ditto-paths';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';

/**
 * Serving graph (derived, gitignored): a query-ready adjacency structure
 * projected one-way from the IR (#5/§4-3). Regenerable — never SoT — so it
 * carries no Zod schema (design §7), only this shape contract.
 */
export interface ServingGraph {
  projection_id: string;
  generated_at: string;
  nodes: Array<{ id: string; node_type: string; name: string }>;
  /** adjacency: node id → outgoing edges. */
  adjacency: Record<string, Array<{ to: string; edge_type: string }>>;
}

/** Append failure when the target event file already exists (immutability/TOCTOU). */
export class MemoryEventExistsError extends Error {
  constructor(public readonly eventId: string) {
    super(`memory event ${eventId} already exists; events are immutable (append-only)`);
    this.name = 'MemoryEventExistsError';
  }
}

export class MemorySourceStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return join(dittoDir(this.repoRoot), 'memory', 'sources');
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async exists(id: string): Promise<boolean> {
    return Bun.file(this.path(id)).exists();
  }

  async get(id: string): Promise<MemorySource> {
    return readJson(this.path(id), memorySource);
  }

  async write(source: MemorySource): Promise<MemorySource> {
    return writeJson(this.path(source.source_id), memorySource, source);
  }

  async list(): Promise<MemorySource[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir());
    } catch {
      return [];
    }
    const out: MemorySource[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(await readJson(join(this.dir(), name), memorySource));
      } catch {
        // skip malformed entries; explicit get() surfaces the schema error
      }
    }
    return out;
  }
}

export class MemoryEventStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return join(dittoDir(this.repoRoot), 'memory', 'events');
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  /**
   * Write one event as an immutable per-entity file. Uses the 'wx' open flag so
   * an existing id fails loudly (immutability + no TOCTOU race). Approval/update
   * is a NEW event with `supersedes` + `status=approved`, never a mutation here.
   */
  async append(event: MemoryEvent): Promise<MemoryEvent> {
    const validated = memoryEvent.parse(event);
    const path = this.path(validated.event_id);
    await ensureDir(dirname(path));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MemoryEventExistsError(validated.event_id);
      }
      throw err;
    }
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return validated;
  }

  async get(id: string): Promise<MemoryEvent> {
    return readJson(this.path(id), memoryEvent);
  }

  /** All events sorted by created_at ascending (ties broken by event_id). */
  async list(): Promise<MemoryEvent[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir());
    } catch {
      return [];
    }
    const out: MemoryEvent[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(await readJson(join(this.dir(), name), memoryEvent));
      } catch {
        // skip malformed entries
      }
    }
    out.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.event_id < b.event_id ? -1 : 1;
    });
    return out;
  }
}

export class MemoryGraphIrStore {
  constructor(public readonly repoRoot: string) {}

  private path(): string {
    return localDir(this.repoRoot, 'memory', 'ir', 'graph-ir.json');
  }

  async read(): Promise<MemoryGraphIr | null> {
    if (!(await Bun.file(this.path()).exists())) return null;
    return readJson(this.path(), memoryGraphIr);
  }

  /** Whole-file replacement — the IR is a single regenerable current snapshot. */
  async write(ir: MemoryGraphIr): Promise<MemoryGraphIr> {
    return writeJson(this.path(), memoryGraphIr, ir);
  }
}

export class MemoryProjectionStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return localDir(this.repoRoot, 'memory', 'projections');
  }

  private manifestPath(): string {
    return join(this.dir(), 'manifest.json');
  }

  private servingPath(): string {
    return join(this.dir(), 'graph.json');
  }

  private wikiDir(): string {
    return join(this.dir(), 'wiki');
  }

  async readManifest(): Promise<MemoryProjectionManifest | null> {
    if (!(await Bun.file(this.manifestPath()).exists())) return null;
    return readJson(this.manifestPath(), memoryProjectionManifest);
  }

  async writeManifest(m: MemoryProjectionManifest): Promise<MemoryProjectionManifest> {
    return writeJson(this.manifestPath(), memoryProjectionManifest, m);
  }

  /** Write the query-ready serving graph (derived, whole-file replacement). */
  async writeServing(graph: ServingGraph): Promise<ServingGraph> {
    await atomicWriteText(this.servingPath(), `${JSON.stringify(graph, null, 2)}\n`);
    return graph;
  }

  async readServing(): Promise<ServingGraph | null> {
    if (!(await Bun.file(this.servingPath()).exists())) return null;
    return JSON.parse(await Bun.file(this.servingPath()).text()) as ServingGraph;
  }

  /** Write one human-facing wiki markdown file under projections/wiki/. */
  async writeWiki(name: string, markdown: string): Promise<void> {
    await atomicWriteText(join(this.wikiDir(), name), markdown);
  }
}

/** sha256 hex over content (mirrors evidence-store.sha256Hex). */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
