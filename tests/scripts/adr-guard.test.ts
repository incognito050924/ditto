import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADR_RULES,
  type AdrRule,
  countScannedFiles,
  scanAdrViolations,
  scanText,
} from '../../scripts/adr-guard';

const adr0006Forbidden = ADR_RULES.find((r) => r.adr === 'ADR-0006')?.forbidden ?? [];

describe('scanText (pure)', () => {
  test('flags a forbidden typescript import (ADR-0006)', () => {
    expect(adr0006Forbidden.length).toBeGreaterThan(0);
    const hits = scanText("import ts from 'typescript';\nconst x = 1;", adr0006Forbidden);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(1);
  });

  test('clean text yields no hits', () => {
    expect(scanText('const x = 1;\nexport const y = 2;\n', adr0006Forbidden)).toHaveLength(0);
  });

  test('a comment mentioning CodeQL without an import is not a violation', () => {
    const stopForbidden = ADR_RULES.find((r) => r.adr === 'ADR-0001')?.forbidden ?? [];
    expect(scanText('// Stop 훅에 CodeQL 금지 (ADR-0001)\n', stopForbidden)).toHaveLength(0);
  });
});

describe('scanAdrViolations (repo scan)', () => {
  test('current repo passes the guard (0 violations)', async () => {
    expect(await scanAdrViolations(process.cwd())).toEqual([]);
  });

  test('the pass message includes the scanned .ts file count', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'adr-guard-'));
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
      await writeFile(join(repo, 'src', 'b.ts'), 'export const y = 2;\n');
      await writeFile(join(repo, 'src', 'c.txt'), 'not typescript\n');
      const rules: AdrRule[] = [
        { adr: 'ADR-0006', description: 't', targets: ['src'], forbidden: adr0006Forbidden },
      ];
      expect(await countScannedFiles(repo, rules)).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('detects an injected ADR-0006 violation under a directory target', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'adr-guard-'));
    try {
      await mkdir(join(repo, 'src', 'acg'), { recursive: true });
      await writeFile(join(repo, 'src', 'acg', 'bad.ts'), "import ts from 'typescript';\n");
      const rules: AdrRule[] = [
        { adr: 'ADR-0006', description: 't', targets: ['src'], forbidden: adr0006Forbidden },
      ];
      const violations = await scanAdrViolations(repo, rules);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.adr).toBe('ADR-0006');
      expect(violations[0]?.file).toContain('bad.ts');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
