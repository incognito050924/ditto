import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function readTextIfExists(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null;
  return Bun.file(path).text();
}

export async function readJsonIfExists(path: string): Promise<unknown | null> {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  return JSON.parse(text);
}

function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner
      .split(',')
      .map((part) => part.trim())
      .map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part));
  }
  return trimmed;
}

export function parseTomlSubset(text: string): Record<string, Record<string, unknown>> {
  const root: Record<string, Record<string, unknown>> = { '': {} };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? '';
      root[section] ??= {};
      continue;
    }
    const equal = line.indexOf('=');
    if (equal === -1) continue;
    const key = line.slice(0, equal).trim();
    const value = line.slice(equal + 1);
    root[section] ??= {};
    const current = root[section];
    if (current) current[key] = parseValue(value);
  }
  return root;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export function envKeys(value: unknown): string[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.keys(record).sort();
}

export async function listDirectories(base: string): Promise<Array<{ id: string; path: string }>> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, path: join(base, entry.name) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function listFiles(base: string): Promise<Array<{ id: string; path: string }>> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ id: entry.name, path: join(base, entry.name) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export function parentDir(path: string): string {
  return dirname(path);
}
