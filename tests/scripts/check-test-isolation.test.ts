import { describe, expect, test } from 'bun:test';
import { ALLOWLIST, detectIsolationViolations } from '../../scripts/check-test-isolation';

// All fixtures are in-memory strings (path + content). This test never writes
// to the real repo's `.ditto/` — it would otherwise trip the very guard it tests
// (self-reference). detectIsolationViolations is pure: it scans the given files.

describe('detectIsolationViolations (pure)', () => {
  test('flags a write to the real repo .ditto/local anchored to REPO_ROOT', () => {
    const content = [
      "const REPO_ROOT = join(import.meta.dir, '..', '..');",
      "await writeFile(join(REPO_ROOT, '.ditto', 'local', 'out.json'), '{}');",
    ].join('\n');
    const v = detectIsolationViolations([{ path: 'tests/x/bad.test.ts', content }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe('tests/x/bad.test.ts');
    expect(v[0]?.line).toBe(2);
    // names the concrete shared state it touched
    expect(v[0]?.reason).toContain('.ditto/local');
  });

  test('flags a slash-path literal write anchored to process.cwd()', () => {
    const content = "writeFileSync(`${process.cwd()}/.ditto/runs/x.log`, 'x');";
    const v = detectIsolationViolations([{ path: 'tests/y/bad2.test.ts', content }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain('.ditto/runs');
  });

  test('flags mkdir of real .ditto/knowledge anchored to repoRoot', () => {
    const content = "await mkdir(join(repoRoot, '.ditto', 'knowledge'), { recursive: true });";
    const v = detectIsolationViolations([{ path: 'tests/z/bad3.test.ts', content }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain('.ditto/knowledge');
  });

  test('an isolated mkdtemp/tmpdir write is NOT a violation', () => {
    const content = [
      'const repo = await mkdtemp(join(tmpdir(), "ditto-"));',
      "await mkdir(join(repo, '.ditto', 'local'), { recursive: true });",
      "await writeFile(join(dir, '.ditto', 'runs', 'r.log'), 'x');",
    ].join('\n');
    expect(detectIsolationViolations([{ path: 'tests/ok/iso.test.ts', content }])).toEqual([]);
  });

  test('reading the real repo .ditto/local is NOT a write violation', () => {
    const content = "readFileSync(join(REPO_ROOT, '.ditto', 'local', 'surfaces.json'), 'utf8');";
    expect(detectIsolationViolations([{ path: 'tests/ok/read.test.ts', content }])).toEqual([]);
  });

  test('a write to a real-repo path outside .ditto/{local,runs,knowledge} is NOT flagged', () => {
    const content = "await writeFile(join(REPO_ROOT, 'tmp', 'scratch.txt'), 'x');";
    expect(detectIsolationViolations([{ path: 'tests/ok/other.test.ts', content }])).toEqual([]);
  });

  test('allowlisted files are exempt even if they match', () => {
    const allowed = [...ALLOWLIST][0];
    expect(allowed).toBeDefined();
    const content = "await writeFile(join(REPO_ROOT, '.ditto', 'local', 'surfaces.json'), '{}');";
    expect(detectIsolationViolations([{ path: allowed as string, content }])).toEqual([]);
    // ...but a non-allowlisted sibling with the same content IS flagged
    expect(
      detectIsolationViolations([{ path: 'tests/x/not-allowed.test.ts', content }]),
    ).toHaveLength(1);
  });
});

describe('ALLOWLIST', () => {
  test('contains the known pre-existing real-repo .ditto cases', () => {
    expect(ALLOWLIST.has('tests/core/surface-inventory.plugin.test.ts')).toBe(true);
    expect(ALLOWLIST.has('tests/doctor/surface.test.ts')).toBe(true);
  });
});
