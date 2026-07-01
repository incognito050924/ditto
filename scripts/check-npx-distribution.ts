/**
 * npx 배포경로 회귀 가드 (wi_260701dms).
 *
 * 사용자의 유일한 배포 표면은 `npx github:incognito050924/ditto <install|update|uninstall>`
 * 다([[ditto-distribution-intent]]). npm 이 이 repo 를 clone → `npm install` → package `bin`
 * (scripts/npx-bootstrap.mjs)을 verb 와 함께 실행하는 경로가 성립하려면 몇 가지 구조
 * 불변식이 유지돼야 한다. 이 가드는 그 불변식이 깨진 커밋을 정적으로(오프라인) 차단한다.
 *
 * check-test-isolation.ts 의 구조(스캔 → 위반 수집 → 출력 → exit code)를 따른다.
 *
 * 범위 밖(중복 회피, 헌장 4-3):
 *  - bin/ditto 번들 신선도 → pre-commit 이 매 커밋 재빌드+스테이징해 이미 보장.
 *  - 버전 touchpoint drift → scripts/release.mjs 의 릴리스-시 드리프트 가드가 담당.
 *  - 실제 `npx github:…` 왕복 스모크 → push 된 커밋이 있어야 돌므로 릴리스-후 수동/별도.
 *    이 가드는 그 왕복이 의존하는 *정적* 전제만 지킨다.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface DistViolation {
  rule: string;
  detail: string;
}

/** package.json bin.ditto 가 가리켜야 하는 npx 부트스트랩 진입점(repo-relative). */
const EXPECTED_BIN_TARGET = 'scripts/npx-bootstrap.mjs';

/** `./scripts/x.mjs` → `scripts/x.mjs` (선행 `./` 정규화). */
function normalizeBin(p: string): string {
  return p.replace(/^\.\//, '');
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 룰: bin-field — package.json bin.ditto 가 실재하는 npx 부트스트랩을 가리킨다. */
function checkBinField(pkg: Record<string, unknown>, repoRoot: string): DistViolation[] {
  const bin = pkg.bin;
  const target =
    bin && typeof bin === 'object' ? (bin as Record<string, unknown>).ditto : undefined;
  if (typeof target !== 'string') {
    return [{ rule: 'bin-field', detail: 'package.json bin.ditto 누락 — npx 진입점이 없다' }];
  }
  if (normalizeBin(target) !== EXPECTED_BIN_TARGET) {
    return [{ rule: 'bin-field', detail: `bin.ditto=${target} ≠ ${EXPECTED_BIN_TARGET}` }];
  }
  if (!existsSync(join(repoRoot, EXPECTED_BIN_TARGET))) {
    return [
      { rule: 'bin-field', detail: `${EXPECTED_BIN_TARGET} 파일 부재 — npx 진입점이 깨졌다` },
    ];
  }
  return [];
}

/** npx 부트스트랩이 라우팅해야 하는 사용자 표면 verb (사용자 요구: 이 셋 고정). */
const REQUIRED_VERBS = ['install', 'update', 'uninstall'] as const;

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/**
 * 룰: verb-routing — npx-bootstrap 이 install|update|uninstall 를 모두 라우팅한다.
 * `RUN = { install: …, update: …, uninstall: … }[VERB]` 객체 리터럴을 파싱해 세 키의
 * 존재를 확인한다(실행하지 않는 정적 검사). 파일 부재는 bin-field 가 이미 잡으므로 skip.
 */
function checkVerbRouting(bootstrap: string | null): DistViolation[] {
  if (bootstrap === null) return []; // 부재는 bin-field 소관
  const map = bootstrap.match(/RUN\s*=\s*\{([^}]*)\}/);
  if (!map) {
    return [{ rule: 'verb-routing', detail: 'RUN verb 맵을 찾을 수 없다 (부트스트랩 구조 변경?)' }];
  }
  const body = map[1] ?? '';
  const missing = REQUIRED_VERBS.filter((v) => !new RegExp(`(?:^|[{,\\s])${v}\\s*:`).test(body));
  if (missing.length > 0) {
    return [{ rule: 'verb-routing', detail: `RUN 맵에 verb 누락: ${missing.join(', ')}` }];
  }
  return [];
}

/**
 * npm 이 git-clone 을 설치할 때 도는 lifecycle 스크립트 중, npx 부트스트랩 전에 실패해
 * 경로 전체를 깨뜨릴 수 있는 것들. `prepare` 는 clone 시 돌지만 무해해야 하므로(빌드/bun
 * 금지) 별도 처리한다.
 */
const FORBIDDEN_SCRIPTS = ['install', 'preinstall', 'postinstall', 'prepack'] as const;

/**
 * 룰: npm-clone-scripts — clone 시 npx 부트스트랩 실행을 깨뜨리는 lifecycle 스크립트가 없다.
 * bin/ditto 번들과 부트스트랩은 커밋돼 있어 npx 시점 빌드가 불필요하다. 여기서 build/bun 을
 * 도는 lifecycle 스크립트가 끼면, bun 없는 clone 환경의 `npm install` 이 실패해 install/
 * update/uninstall 전부 막힌다.
 */
function checkNpmScripts(pkg: Record<string, unknown>): DistViolation[] {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const out: DistViolation[] = [];
  for (const key of FORBIDDEN_SCRIPTS) {
    if (typeof scripts[key] === 'string') {
      out.push({
        rule: 'npm-clone-scripts',
        detail: `npm lifecycle 스크립트 '${key}' 존재 — clone 설치가 npx 부트스트랩 전에 실행/실패할 수 있다`,
      });
    }
  }
  const prepare = scripts.prepare;
  if (typeof prepare === 'string' && /\bbun\b|build|compile/.test(prepare)) {
    out.push({
      rule: 'npm-clone-scripts',
      detail: `prepare 가 빌드/bun 을 실행한다 ('${prepare}') — bun 없는 npm clone 에서 실패한다`,
    });
  }
  return out;
}

/** 부트스트랩의 `const NAME = '...'` 상수값을 뽑는다(없으면 null). */
function constOf(bootstrap: string, name: string): string | null {
  const m = bootstrap.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
  return m?.[1] ?? null;
}

/**
 * 룰: marketplace-consistency — 부트스트랩이 `claude plugin` 을 부를 때 쓰는 상수
 * (MARKETPLACE·PLUGIN)가 .claude-plugin/marketplace.json 과 일치한다. 어긋나면
 * `claude plugin marketplace/install` 이 이름 불일치로 실패하거나 잘못된 플러그인을 건다.
 * plugin source 는 './'(repo 루트=플러그인 루트, github-source 설치 전제)여야 한다.
 * 부트스트랩 부재는 bin-field 소관이라 skip.
 */
function checkMarketplace(
  bootstrap: string | null,
  marketplace: Record<string, unknown> | null,
): DistViolation[] {
  if (bootstrap === null) return [];
  if (!marketplace) {
    return [
      {
        rule: 'marketplace-consistency',
        detail: '.claude-plugin/marketplace.json 을 읽을 수 없다',
      },
    ];
  }
  const out: DistViolation[] = [];
  const mktName = constOf(bootstrap, 'MARKETPLACE');
  const pluginName = constOf(bootstrap, 'PLUGIN');
  if (mktName && marketplace.name !== mktName) {
    out.push({
      rule: 'marketplace-consistency',
      detail: `marketplace.json name='${String(marketplace.name)}' ≠ 부트스트랩 MARKETPLACE='${mktName}'`,
    });
  }
  const plugins = Array.isArray(marketplace.plugins)
    ? (marketplace.plugins as Record<string, unknown>[])
    : [];
  const entry = plugins.find((p) => p.name === pluginName);
  if (!entry) {
    out.push({
      rule: 'marketplace-consistency',
      detail: `marketplace.json plugins 에 부트스트랩 PLUGIN='${String(pluginName)}' 항목이 없다`,
    });
  } else if (entry.source !== './') {
    out.push({
      rule: 'marketplace-consistency',
      detail: `plugin '${String(pluginName)}' source='${String(entry.source)}' ≠ './' (repo 루트=플러그인 루트 전제 위반)`,
    });
  }
  return out;
}

/** 모든 룰을 돌려 위반 목록을 모은다(빈 배열 = 통과). */
export async function checkNpxDistribution(repoRoot: string): Promise<DistViolation[]> {
  const pkg = await readJson(join(repoRoot, 'package.json'));
  if (!pkg) {
    return [{ rule: 'bin-field', detail: 'package.json 을 읽을 수 없다' }];
  }
  const bootstrap = await readText(join(repoRoot, EXPECTED_BIN_TARGET));
  const marketplace = await readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  return [
    ...checkBinField(pkg, repoRoot),
    ...checkVerbRouting(bootstrap),
    ...checkNpmScripts(pkg),
    ...checkMarketplace(bootstrap, marketplace),
  ];
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const violations = await checkNpxDistribution(repoRoot);
  if (violations.length > 0) {
    console.error(`✗ npx 배포경로 가드 위반 ${violations.length}건 — 커밋/CI 차단:\n`);
    for (const v of violations) console.error(`  [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log('✓ npx 배포경로 가드 통과 — install|update|uninstall 경로 구조 불변식 유지');
}
