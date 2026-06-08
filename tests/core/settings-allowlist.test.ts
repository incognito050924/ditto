import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOW_RULE,
  addAllowRule,
  allowlistSettingsFile,
  removeAllowRule,
  unallowlistSettingsFile,
} from '~/core/settings-allowlist';

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-allowlist-'));
}

describe('addAllowRule', () => {
  test('adds the rule to an empty settings object', () => {
    const next = addAllowRule({});
    expect(next.permissions?.allow).toContain(ALLOW_RULE);
  });

  test('is idempotent — adding twice yields no duplicate', () => {
    const once = addAllowRule({});
    const twice = addAllowRule(once);
    const count = twice.permissions?.allow?.filter((r) => r === ALLOW_RULE).length;
    expect(count).toBe(1);
  });

  test('preserves unrelated settings keys and existing allow rules', () => {
    const next = addAllowRule({
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
    });
    expect(next.model).toBe('opus');
    expect(next.permissions?.allow).toContain('Bash(ls:*)');
    expect(next.permissions?.allow).toContain(ALLOW_RULE);
  });
});

describe('removeAllowRule', () => {
  test('removes the rule while keeping other rules intact', () => {
    const next = removeAllowRule({
      permissions: { allow: ['Bash(ls:*)', ALLOW_RULE] },
    });
    expect(next.permissions?.allow).toContain('Bash(ls:*)');
    expect(next.permissions?.allow).not.toContain(ALLOW_RULE);
  });

  test('tolerates an absent rule (no-op)', () => {
    const next = removeAllowRule({ permissions: { allow: ['Bash(ls:*)'] } });
    expect(next.permissions?.allow).toEqual(['Bash(ls:*)']);
  });

  test('tolerates absent permissions entirely', () => {
    const next = removeAllowRule({ model: 'opus' });
    expect(next.model).toBe('opus');
  });
});

describe('allowlistSettingsFile', () => {
  test('creates .claude/settings.json with the rule under a missing path', async () => {
    const dir = await freshDir();
    try {
      const path = join(dir, '.claude', 'settings.json');
      await allowlistSettingsFile(path);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.permissions.allow).toContain(ALLOW_RULE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves existing keys when allowlisting an existing file', async () => {
    const dir = await freshDir();
    try {
      const path = join(dir, '.claude', 'settings.json');
      await allowlistSettingsFile(path);
      // re-run with extra content present
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify({ model: 'opus' }), 'utf8');
      await allowlistSettingsFile(path);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.model).toBe('opus');
      expect(parsed.permissions.allow).toContain(ALLOW_RULE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('unallowlistSettingsFile', () => {
  test('removes the rule from an existing file', async () => {
    const dir = await freshDir();
    try {
      const path = join(dir, '.claude', 'settings.json');
      await allowlistSettingsFile(path);
      await unallowlistSettingsFile(path);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.permissions.allow).not.toContain(ALLOW_RULE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op when the file is missing', async () => {
    const dir = await freshDir();
    try {
      const path = join(dir, '.claude', 'settings.json');
      await expect(unallowlistSettingsFile(path)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
