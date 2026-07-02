import { describe, expect, test } from 'bun:test';
import { projectJourneyToPlan } from '~/core/e2e/plan-adapter';
import { journeyFrontMatter } from '~/schemas/journey-dsl';

/**
 * ac-2 (Contract 2): the deterministic DSL v2 → Playwright plan.md adapter.
 * A rich v2 journey (cases + one edge_case + one failure_state + auth/seed +
 * a secret_var) must project to the official plan format: Application Overview
 * (intent + constraints), one scenario per case, one `###` per edge_case, one
 * `###` per failure_state carrying its error Expected Result, a `**Seed:**`
 * line — and the secret column must appear only as `<env:...>` while the
 * sidecar map joins plan step N → DSL step id (sN).
 */

const journey = journeyFrontMatter.parse({
  ditto_journey: 'v2',
  id: 'jrn-login',
  name: '로그인',
  description: '사용자가 로그인해 대시보드에 진입한다.',
  surfaces: ['page:/login'],
  implementation_intent: '등록 사용자가 로그인하면 대시보드로 이동한다.',
  constraints: ['응답은 2초 이내', '실패는 명확한 오류 메시지'],
  edge_cases: [{ case: '빈 비밀번호 제출', handling: '제출 버튼이 비활성화된다' }],
  failure_states: [{ trigger: '인증 서버 500', expected: '오류 배너가 표시된다' }],
  secret_vars: ['password'],
  auth: { credentials: { admin: 'env:ADMIN_PW' } },
  seed: { spec_ref: 'e2e/seed.spec.ts' },
});

const body = `
1. [s1] 방문: /login
2. [s2] 입력: "비밀번호" 칸에 {password}
3. [s3] 클릭: "로그인" 버튼
4. [s4] (케이스: 정상) 확인: "대시보드" visible
5. [s5] (케이스: 실패) 확인: "오류" visible

## 케이스

| 케이스 | password |
|---|---|
| 정상 | test1234 |
| 실패 | wrong-pass |
`;

function project() {
  return projectJourneyToPlan({
    journey,
    body,
    blocks: {},
    sourcePath: 'e2e/journeys/login.journey.md',
    digest: 'sha256:abc123',
    resolveVar: (v) =>
      v === 'password' ? 'test1234' : v === 'ADMIN_PW' ? 's3cr3t-value' : undefined,
  });
}

describe('projectJourneyToPlan (ac-2)', () => {
  test('emits the official plan header + digest comment', () => {
    const { plan } = project();
    expect(plan).toContain('# 로그인 Test Plan');
    expect(plan).toContain(
      '<!-- @ditto-plan v1 · source: e2e/journeys/login.journey.md · digest: sha256:abc123 -->',
    );
  });

  test('Application Overview carries the implementation intent + constraints', () => {
    const { plan } = project();
    expect(plan).toContain('## Application Overview');
    expect(plan).toContain('등록 사용자가 로그인하면 대시보드로 이동한다.');
    expect(plan).toContain('**Constraints:**');
    expect(plan).toContain('응답은 2초 이내');
    expect(plan).toContain('실패는 명확한 오류 메시지');
  });

  test('one scenario case (####) per journey case', () => {
    const { plan } = project();
    expect(plan).toContain('## Test Scenarios');
    expect(plan).toContain('### 1. 로그인');
    expect(plan).toContain('#### 1.1 정상');
    expect(plan).toContain('#### 1.2 실패');
    // action verbs → Steps; 확인: → Expected Results
    expect(plan).toContain('**Steps:**');
    expect(plan).toContain('**Expected Results:**');
    expect(plan).toContain('"대시보드" visible');
  });

  test('each edge_case becomes its own ### scenario with handling as Expected Result', () => {
    const { plan } = project();
    expect(plan).toContain('### 2. 빈 비밀번호 제출');
    expect(plan).toContain('제출 버튼이 비활성화된다');
  });

  test('each failure_state becomes its own ### scenario with the error Expected Result', () => {
    const { plan } = project();
    expect(plan).toContain('### 3. 인증 서버 500');
    expect(plan).toContain('오류 배너가 표시된다');
  });

  test('a **Seed:** line references the seed spec', () => {
    const { plan } = project();
    expect(plan).toContain('**Seed:** `e2e/seed.spec.ts`');
  });

  test('the secret column appears only as <env:...>, never as a literal', () => {
    const { plan, redactions } = project();
    expect(plan).toContain('<env:password>');
    expect(plan).not.toContain('test1234');
    expect(plan).not.toContain('wrong-pass');
    expect(plan).not.toContain('s3cr3t-value');
    expect(redactions.some((r) => r.field === 'password')).toBe(true);
  });

  test('the sidecar map joins plan step N → DSL step id (sN)', () => {
    const { map } = project();
    expect(map[1]?.정상?.[1]).toBe('s1');
    expect(map[1]?.정상?.[2]).toBe('s2');
    expect(map[1]?.정상?.[3]).toBe('s3');
    // 실패 case shares the same active action steps
    expect(map[1]?.실패?.[1]).toBe('s1');
  });

  test('the assertion channel records active 확인: step ids per case (ac-4)', () => {
    // 확인: steps go to Expected Results (not the numbered Steps map), so they get
    // their own ordered channel keyed by scenario/case — the post-pass reads this
    // to mark the expect(...) lines. s4 is active only in 정상, s5 only in 실패.
    const { assertions } = project();
    expect(assertions[1]?.정상).toEqual(['s4']);
    expect(assertions[1]?.실패).toEqual(['s5']);
    // Action steps stay out of the assertion channel (they are in `map`).
    expect(assertions[1]?.정상).not.toContain('s1');
  });
});

describe('projectJourneyToPlan — block inlining', () => {
  const blockJourney = journeyFrontMatter.parse({
    ditto_journey: 'v2',
    id: 'jrn-with-block',
    name: '블록 여정',
    description: '블록을 인라인한다.',
    surfaces: ['page:/x'],
    implementation_intent: '블록 스텝이 인라인되어야 한다.',
    uses_blocks: ['login-block'],
  });

  const blockBody = `
1. [s1] 방문: /x
2. [s2] 블록: login-block
3. [s3] 클릭: "확인" 버튼
`;

  const blocks = {
    'login-block': {
      body: `
1. [b1] 입력: "아이디" 칸에 admin
2. [b2] 클릭: "로그인" 버튼
`,
    },
  };

  test('inlines block steps and records their bN ids in the map', () => {
    const { plan, map } = projectJourneyToPlan({
      journey: blockJourney,
      body: blockBody,
      blocks,
      sourcePath: 'e2e/journeys/with-block.journey.md',
      digest: 'sha256:def',
    });
    // no case table → single 기본 case; block expands between s1 and s3
    expect(map[1]?.기본?.[1]).toBe('s1');
    expect(map[1]?.기본?.[2]).toBe('b1');
    expect(map[1]?.기본?.[3]).toBe('b2');
    expect(map[1]?.기본?.[4]).toBe('s3');
    expect(plan).toContain('입력: "아이디" 칸에 admin');
    expect(plan).toContain('클릭: "로그인" 버튼');
  });
});

describe('projectJourneyToPlan — 미설정 센티널(—) 조건 필터·치환', () => {
  // DSL-GUIDE §5/§7: 케이스표 셀 `—`(em-dash) = 그 변수 미설정. (변수 있음)은
  // 설정된 케이스에서만, (변수 없음)은 미설정 케이스에서만 활성이어야 한다.
  const couponJourney = journeyFrontMatter.parse({
    ditto_journey: 'v2',
    id: 'jrn-coupon',
    name: '쿠폰',
    description: '쿠폰 유무에 따라 단계가 갈린다.',
    surfaces: ['page:/checkout'],
    implementation_intent: '쿠폰이 있으면 입력하고, 없으면 할인 없음을 확인한다.',
  });

  const couponBody = `
1. [s1] 방문: /checkout
2. [s2] (coupon 있음) 입력: "쿠폰" 칸에 {coupon}
3. [s3] (coupon 없음) 확인: "할인 없음" visible
4. [s4] 클릭: "주문" 버튼

## 케이스

| 케이스 | coupon |
|---|---|
| 쿠폰있음 | WELCOME10 |
| 쿠폰없음 | — |
`;

  function projectCoupon() {
    return projectJourneyToPlan({
      journey: couponJourney,
      body: couponBody,
      blocks: {},
      sourcePath: 'e2e/journeys/coupon.journey.md',
      digest: 'sha256:coupon',
    });
  }

  test('(변수 있음) 액션 단계는 미설정(—) 케이스 map에서 제외되고 설정 케이스엔 남는다', () => {
    const { map } = projectCoupon();
    expect(Object.values(map[1]?.쿠폰없음 ?? {})).not.toContain('s2');
    expect(Object.values(map[1]?.쿠폰있음 ?? {})).toContain('s2');
  });

  test('(변수 없음) 확인 단계는 미설정(—) 케이스에서만 활성이다', () => {
    const { assertions } = projectCoupon();
    expect(assertions[1]?.쿠폰없음).toContain('s3');
    expect(assertions[1]?.쿠폰있음 ?? []).not.toContain('s3');
  });

  test('미설정(—) 값을 리터럴 —로 치환하지 않는다', () => {
    const { plan } = projectCoupon();
    expect(plan).not.toContain('칸에 —');
  });
});
