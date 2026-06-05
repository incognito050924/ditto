import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseTomlText } from 'smol-toml';
import { parse as parseYamlText } from 'yaml';

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

export function parseToml(text: string): Record<string, unknown> {
  return parseTomlText(text) as Record<string, unknown>;
}

/** YAML 텍스트를 파싱하는 wrapper(`yaml` 패키지). 사람이 손으로 쓰는 산출물용. */
export function parseYaml(text: string): unknown {
  return parseYamlText(text);
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
