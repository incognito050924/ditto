import { describe, expect, test } from 'bun:test';
import {
  type CodeqlDoctorDeps,
  classifyCodeqlTarget,
  classifyExtensions,
  inspectCodeqlTarget,
} from '~/core/codeql/doctor';

describe('classifyExtensions', () => {
  test('groups extensions into CodeQL languages, sorted by file count', () => {
    const { languages, unsupported } = classifyExtensions({ ts: 100, tsx: 20, py: 5, md: 999 });
    expect(languages).toEqual([
      { language: 'javascript', files: 120 },
      { language: 'python', files: 5 },
    ]);
    expect(unsupported).toEqual([]); // .md는 소스 아님 → 무시
  });

  test('separates known-unsupported source extensions', () => {
    const { languages, unsupported } = classifyExtensions({ php: 40, scala: 10 });
    expect(languages).toEqual([]);
    expect(unsupported).toEqual([
      { ext: 'php', files: 40 },
      { ext: 'scala', files: 10 },
    ]);
  });

  test('maps kotlin (.kt) to the java extractor', () => {
    const { languages } = classifyExtensions({ kt: 50 });
    expect(languages).toEqual([{ language: 'java', files: 50 }]);
  });
});

describe('classifyCodeqlTarget — fail-closed findings', () => {
  // done_when ①: 지원 해석 언어 + CLI 가용 + 미지원 없음 → finding 0 (exit 0).
  test('clean JS/TS target produces no findings', () => {
    const findings = classifyCodeqlTarget({
      languages: [{ language: 'javascript', files: 120 }],
      unsupported: [],
      cliAvailable: true,
    });
    expect(findings).toEqual([]);
  });

  // done_when ②: Kotlin(컴파일) build 미입증 → fail-closed finding (exit 1).
  test('compiled language without build verification is blocked', () => {
    const findings = classifyCodeqlTarget({
      languages: [{ language: 'java', files: 666 }],
      unsupported: [],
      cliAvailable: true,
    });
    expect(findings.map((f) => f.kind)).toContain('compiled-language-build-unverified');
    expect(findings[0].severity).toBe('high');
  });

  test('compiled language WITH build verification passes', () => {
    const findings = classifyCodeqlTarget({
      languages: [{ language: 'java', files: 666 }],
      unsupported: [],
      cliAvailable: true,
      buildVerified: true,
    });
    expect(findings).toEqual([]);
  });

  // done_when ③: 미지원 언어(PHP) → finding (exit 1).
  test('unsupported-only target is a high finding', () => {
    const findings = classifyCodeqlTarget({
      languages: [],
      unsupported: [{ ext: 'php', files: 40 }],
      cliAvailable: true,
    });
    expect(findings.map((f) => f.kind)).toContain('language-unsupported');
  });

  test('missing CLI is always a high finding (fail-closed)', () => {
    const findings = classifyCodeqlTarget({
      languages: [{ language: 'javascript', files: 10 }],
      unsupported: [],
      cliAvailable: false,
    });
    expect(findings.map((f) => f.kind)).toContain('cli-unavailable');
  });

  test('no source at all is a finding', () => {
    const findings = classifyCodeqlTarget({ languages: [], unsupported: [], cliAvailable: true });
    expect(findings.map((f) => f.kind)).toContain('no-source-detected');
  });

  test('supported + unsupported mix warns but does not hard-block on language', () => {
    const findings = classifyCodeqlTarget({
      languages: [{ language: 'javascript', files: 100 }],
      unsupported: [{ ext: 'php', files: 5 }],
      cliAvailable: true,
    });
    const langFinding = findings.find((f) => f.kind === 'language-unsupported');
    expect(langFinding?.severity).toBe('medium'); // 섞인 경우는 medium(우세 언어는 분석됨)
  });
});

describe('inspectCodeqlTarget — execution', () => {
  function deps(extCounts: Record<string, number>, cli: boolean): CodeqlDoctorDeps {
    return {
      collectExtensions: async () => extCounts,
      cliAvailable: async () => cli,
    };
  }

  test('assembles a report with detected languages and findings', async () => {
    const report = await inspectCodeqlTarget(
      { sourceRoot: '/repo/src' },
      deps({ ts: 50, kt: 10 }, true),
    );
    expect(report.source_root).toBe('/repo/src');
    expect(report.detected_languages.map((l) => l.language)).toContain('javascript');
    expect(report.cli_available).toBe(true);
    // kt(java, 컴파일) build 미입증 → finding.
    expect(report.finding_count).toBeGreaterThan(0);
    expect(report.findings.map((f) => f.kind)).toContain('compiled-language-build-unverified');
  });

  test('clean JS/TS target reports zero findings', async () => {
    const report = await inspectCodeqlTarget({ sourceRoot: '/repo/src' }, deps({ ts: 50 }, true));
    expect(report.finding_count).toBe(0);
    expect(report.build_verified).toBe(false);
  });
});
