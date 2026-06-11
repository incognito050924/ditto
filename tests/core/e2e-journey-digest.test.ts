import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFlakyHistory } from '~/core/e2e/failure-verdict';
import {
  computeSourceDigest,
  detectStale,
  isDittoGenerated,
  parseGeneratedHeader,
  partitionSpecFiles,
  renderGeneratedHeader,
  sha256Hex,
} from '~/core/e2e/journey-digest';

const journeySource = `---
ditto_journey: v1
id: jrn-checkout-coupon
---
1. [s1] 이동: /checkout
`;

function generatedSpec(sourceBytes: string): string {
  const header = renderGeneratedHeader({
    sourcePath: 'e2e/journeys/checkout-coupon.journey.md',
    digest: sha256Hex(sourceBytes),
    kind: 'journey',
    id: 'jrn-checkout-coupon',
  });
  return `${header}\nimport { test } from '@playwright/test';\n`;
}

describe('generated header (ac-4)', () => {
  test('renderGeneratedHeader embeds source, digest and journey id; parse round-trips', () => {
    const spec = generatedSpec(journeySource);
    expect(spec).toContain('@ditto-generated');
    expect(spec).toContain('@ditto-source e2e/journeys/checkout-coupon.journey.md');
    expect(spec).toContain(`@ditto-digest sha256:${sha256Hex(journeySource)}`);
    const parsed = parseGeneratedHeader(spec);
    expect(parsed).toEqual({
      source: 'e2e/journeys/checkout-coupon.journey.md',
      digest: sha256Hex(journeySource),
      journey: 'jrn-checkout-coupon',
    });
  });

  test('block headers carry @ditto-block instead of @ditto-journey', () => {
    const header = renderGeneratedHeader({
      sourcePath: 'e2e/journeys/blocks/login-as-user.block.md',
      digest: 'a'.repeat(64),
      kind: 'block',
      id: 'login-as-user',
    });
    const parsed = parseGeneratedHeader(header);
    expect(parsed?.block).toBe('login-as-user');
    expect(parsed?.journey).toBeUndefined();
  });

  test('parseGeneratedHeader returns null on a human-authored spec', () => {
    expect(parseGeneratedHeader("import { test } from '@playwright/test';\n")).toBeNull();
  });
});

describe('detectStale (ac-4: DSL 변경 후 미재생성 감지)', () => {
  test('fresh generation is not stale; editing the DSL without regenerating IS stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'checkout-coupon.journey.md');
    const generatedAbs = join(dir, 'checkout-coupon.spec.ts');
    await writeFile(sourceAbs, journeySource);
    await writeFile(generatedAbs, generatedSpec(journeySource));

    const fresh = await detectStale(sourceAbs, generatedAbs);
    expect(fresh.stale).toBe(false);

    // DSL changes, the generated spec does not → mechanically detected as stale.
    await writeFile(sourceAbs, `${journeySource}2. [s2] 클릭: 결제\n`);
    const stale = await detectStale(sourceAbs, generatedAbs);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toContain('digest');
  });

  test('a generated file without a digest header is stale (cannot prove freshness)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'a.journey.md');
    const generatedAbs = join(dir, 'a.spec.ts');
    await writeFile(sourceAbs, journeySource);
    await writeFile(generatedAbs, '// no header\n');
    const out = await detectStale(sourceAbs, generatedAbs);
    expect(out.stale).toBe(true);
  });

  test('a missing generated file is stale (never generated)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'a.journey.md');
    await writeFile(sourceAbs, journeySource);
    const out = await detectStale(sourceAbs, join(dir, 'missing.spec.ts'));
    expect(out.stale).toBe(true);
  });
});

// Full valid journey front-matter (appendFlakyHistory re-validates the schema).
const fullJourneySource = `---
ditto_journey: v1
id: jrn-checkout-coupon
name: 쿠폰 적용 결제
description: 쿠폰 할인이 결제 금액에 반영된다.
surfaces:
  - page:/checkout
uses_blocks: []
flaky_history: []
---

1. [s1] 방문: /checkout
`;

function canonicalSpec(sourceText: string): string {
  const header = renderGeneratedHeader({
    sourcePath: 'e2e/journeys/checkout-coupon.journey.md',
    digest: computeSourceDigest(sourceText),
    kind: 'journey',
    id: 'jrn-checkout-coupon',
  });
  return `${header}\nimport { test } from '@playwright/test';\n`;
}

describe('computeSourceDigest (O-2: flaky_history는 digest 입력에서 제외)', () => {
  test('flaky_history만 다른 두 문서의 digest는 같다', () => {
    const withFlaky = fullJourneySource.replace(
      'flaky_history: []',
      'flaky_history:\n  - date: "2026-06-11"\n    case: 기본\n    note: 간헐 타임아웃',
    );
    expect(computeSourceDigest(withFlaky)).toBe(computeSourceDigest(fullJourneySource));
    // 운영 메타데이터가 아닌 본문 변경은 digest를 바꾼다.
    expect(computeSourceDigest(`${fullJourneySource}2. [s2] 클릭: 결제\n`)).not.toBe(
      computeSourceDigest(fullJourneySource),
    );
  });

  test('front-matter가 없는 문서(블록 외 텍스트)는 raw 바이트 digest와 같다', () => {
    expect(computeSourceDigest('plain text\n')).toBe(sha256Hex('plain text\n'));
  });
});

describe('detectStale × flaky 기록 (O-2 재현 수정)', () => {
  test('flaky 판정 기록 후에도 canonical digest 헤더는 stale이 아니다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'checkout-coupon.journey.md');
    const generatedAbs = join(dir, 'checkout-coupon.spec.ts');
    await writeFile(sourceAbs, fullJourneySource);
    await writeFile(generatedAbs, canonicalSpec(fullJourneySource));

    expect((await detectStale(sourceAbs, generatedAbs)).stale).toBe(false);
    await appendFlakyHistory(sourceAbs, {
      date: '2026-06-11',
      case: '기본',
      note: '간헐 타임아웃',
    });
    const after = await detectStale(sourceAbs, generatedAbs);
    expect(after.stale).toBe(false);

    // 본문이 실제로 바뀌면 여전히 stale.
    await writeFile(sourceAbs, `${fullJourneySource}2. [s2] 클릭: 결제\n`);
    expect((await detectStale(sourceAbs, generatedAbs)).stale).toBe(true);
  });

  test('구버전 raw 바이트 digest 헤더도 fresh로 인정된다 (하위 호환)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'a.journey.md');
    const generatedAbs = join(dir, 'a.spec.ts');
    await writeFile(sourceAbs, fullJourneySource);
    await writeFile(generatedAbs, generatedSpec(fullJourneySource)); // raw sha256 헤더
    expect((await detectStale(sourceAbs, generatedAbs)).stale).toBe(false);
  });
});

describe('detectStale expectedSource (O-15: 헤더 source 경로 대조)', () => {
  test('헤더 @ditto-source가 기대 경로와 다르면 stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    const sourceAbs = join(dir, 'b.journey.md');
    const generatedAbs = join(dir, 'b.spec.ts');
    await writeFile(sourceAbs, fullJourneySource);
    await writeFile(generatedAbs, canonicalSpec(fullJourneySource));
    // 헤더는 e2e/journeys/checkout-coupon.journey.md를 가리킨다 — b.journey.md 기대 시 불일치.
    const out = await detectStale(sourceAbs, generatedAbs, 'e2e/journeys/b.journey.md');
    expect(out.stale).toBe(true);
    expect(out.reason).toContain('@ditto-source');
    // 일치하면 fresh.
    const ok = await detectStale(
      sourceAbs,
      generatedAbs,
      'e2e/journeys/checkout-coupon.journey.md',
    );
    expect(ok.stale).toBe(false);
  });
});

describe('derived vs human identification (ac-8)', () => {
  test('isDittoGenerated: marker present → true; human spec → false', () => {
    expect(isDittoGenerated(generatedSpec(journeySource))).toBe(true);
    expect(
      isDittoGenerated("import { test } from '@playwright/test';\ntest('human', () => {});\n"),
    ).toBe(false);
  });

  test('prose mentioning the marker mid-line is not identified as generated', () => {
    expect(isDittoGenerated("const s = 'docs say @ditto-generated means derived';\n")).toBe(false);
  });

  test('partitionSpecFiles splits a directory into generated vs manual', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-dsl-'));
    await mkdir(join(dir, 'support'), { recursive: true });
    await writeFile(join(dir, 'checkout.spec.ts'), generatedSpec(journeySource));
    await writeFile(join(dir, 'human.spec.ts'), "test('human', () => {});\n");
    await writeFile(join(dir, 'support', 'login.block.ts'), generatedSpec(journeySource));
    const out = await partitionSpecFiles(dir);
    expect(out.generated.sort()).toEqual(['checkout.spec.ts', 'support/login.block.ts']);
    expect(out.manual).toEqual(['human.spec.ts']);
  });
});
