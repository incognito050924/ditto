import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const cli = join(process.cwd(), 'src/cli/index.ts');

function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', cli, ...args], { env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

const payload = (triggers: object, delta: object) => JSON.stringify({ triggers, delta });

describe('ditto knowledge gate CLI (axis-4 trigger gate)', () => {
  test('consistent trigger↔content → PASS, exit 0', () => {
    const res = run([
      'knowledge',
      'gate',
      '--json',
      payload(
        { adr_worthy_decision: true, new_agreed_term: true, repeated_pattern: false },
        { decisions: 1, glossary_terms: 2, patterns: 0, learnings: 0 },
      ),
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.pass).toBe(true);
  });

  test('over-recording (content, no trigger) → FAIL, non-zero exit', () => {
    const res = run([
      'knowledge',
      'gate',
      '--json',
      payload(
        { adr_worthy_decision: false, new_agreed_term: false, repeated_pattern: false },
        { decisions: 1, glossary_terms: 0, patterns: 0, learnings: 0 },
      ),
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.pass).toBe(false);
    expect(out.reasons.join(' ')).toContain('over-recording');
  });

  test('under-recording (trigger, no content) → FAIL, non-zero exit', () => {
    const res = run([
      'knowledge',
      'gate',
      '--json',
      payload(
        { adr_worthy_decision: true, new_agreed_term: false, repeated_pattern: false },
        { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 },
      ),
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toContain('under-recording');
  });

  test('no trigger + nothing recorded → PASS (explicit skip), exit 0', () => {
    const res = run([
      'knowledge',
      'gate',
      '--json',
      payload(
        { adr_worthy_decision: false, new_agreed_term: false, repeated_pattern: false },
        { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 },
      ),
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.pass).toBe(true);
  });
});
