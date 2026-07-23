# 순효능 증거 감사 — palimpsest 3-arm ablation (B0 / B1 / A) 최종 보고서

> **목적**: "풀 DITTO 제품 통째가 얇은 헌장 문서 주입 대비 순효능을 내는가"를
> 사전 등록 규칙 위에서 판정한 캠페인(wi_2607227xx, 이슈 #66·에픽 #64 단계 2/5)의
> 최종 측정 보고서.
> **판정 상태**: 기계 판정 **keep(§3-3a)** — 이것은 동결 규칙이 산출한 기계
> 판정이지 서명이 아니다. **최종 keep 서명은 사용자 몫**이며(동결 rules.md §3),
> 이 보고서가 그 서명의 입력물이다.
> **소비자**: 사용자 서명 · #67(패리티 감사 재진입) · #69(main flip) 게이트 입력.
> **정본 데이터**: `reports/measurements/efficacy-ablation-3arm/scoring/verdict.json`
> (schema `ablation-verdict/2`) · 동 디렉터리 `scoring-log.md` ·
> `runs/ledger.jsonl`(원시 산출물과 함께 비커밋·로컬, tamper-evident 해시 체인).

## 1. 프레이밍·설계

### 1-1. 세 arm

| arm | 구성 | 역할 |
|---|---|---|
| **A** | **풀 DITTO 제품 통째** — 엔진+오케스트레이션+PreToolUse 훅+완료게이트 = 옛 `bin/ditto`(동결 실행물 sha256 `7120a7f4…`, landed 앵커 커밋 `4edee81`) | 처치 |
| **B1** | 헌장 문서(CLAUDE.md 스냅샷, digest `3aec7335…`)만 주입 | 핵심 대조 — "값싼 DITTO" |
| **B0** | 맨 Claude Code(지침 없음) | 문맥 바닥선 — A-vs-B1 판정 산식 불개입(§9), `S_B0 ≥ S_B1`이면 "헌장 자체 무효능" 신호 명기 의무 |

fixture는 비-DITTO 실프로젝트 palimpsest(Python/pytest, tree-sitter 다언어 추출
→ Neo4j)다 — ADR-20260713(ditto의 가치는 사용자 프로젝트에서 발현)에 따라
efficacy 주장은 비-DITTO fixture가 선결이다. fixture 커밋은
`20435ccdbfe4a5a70e198aaeec5d608fa9f490da`로 동결(다르면 I-5 무효).

### 1-2. 사전 등록·동결

- 어떤 arm 세션보다 먼저 판정 번들이 커밋 동결됐다: 1차(task-1) 번들
  `b9585a36dee69fbe5e30e6665dbf06140daf6d2d`, 2차(task-2) 번들
  `392e2adb7559ab3e805ad83ccd83b1b17638fc74`. 번들 = 판정 규칙(rules.md ·
  수치 임계 D1~D4·무효술어 I-1~I-6·상한·arm 대칭·꼬리사건 규칙), oracle(세션 전
  red 실증), 공유 프롬프트, arm A 고정 답변세트, 동결 실행물/헌장.
- sha 참조체인 `injected == frozen == committed blob` 3변을 `score.sh
  verify-chain`이 매 세션·채점 전후로 검증 — 15 유효 세션 전부 통과
  (scoring-log §1·§10·§14).
- 동결 이후 수치·술어 변경 금지. 하네스(비동결) 수정은 원장 기록 경로로만
  4건(§5-2) — 번들 무변경이 verify-chain으로 입증됨.

### 1-3. 격리 샌드박스 (양성대조 실증)

attempt마다 일회용 샌드박스: 격리 `HOME`/`CLAUDE_CONFIG_DIR`(전역 `~/.claude`
무접촉), clone `--no-hardlinks`+origin 제거, env는 화이트리스트 재구성(`env -i`
— 자격증명·`DITTO_SKIP_HOOKS` 류는 존재 자체가 불가능), egress는 2층(SBPL
`deny network-outbound` 집행층 + 루프백 allowlist 프록시 관측층, 전 허용/거부
JSONL 기록). **양성 대조 5종이 경계를 고의로 넘어 실제 차단됨을 매 attempt
증명**했고(하네스 self-check 50항목 전부 ok — `harness/self-check.out`),
격리 술어는 "비허용 egress **성공** 0회"다(§5-4의 문구 정정 참조).

### 1-4. 판정 산식 (동결 rules.md 요지)

- 지표 서열: 1급 결과 `S`(oracle green ∧ 스코프드 스위트 무회귀 ∧ 테스트 표면
  무변조) > 2급 규율 `D`(blind 뷰 기계 감점식 T-1~T-5, 0–100) > 3급 비용
  `C`(A÷B1 벽시계 중앙값 비율).
- 3단 판정: `ΔS≥2`→keep(§3-1) · `ΔS≤−2`→no-net-efficacy · `|ΔS|≤1`이면 규율·
  비용으로 분기 — 특히 §3-3a: `ΔD≥+20 ∧ C<2.0`→keep. 식별 실패는
  insufficient-evidence(§3-3e), 단 §8 2차(모호형 과제 1개 추가, 합산 재판정)
  발동조건을 먼저 검사.
- N=3/arm/과제, 시행 상한 15(유·무효 전체, 원장 집행 — §5-5의 1회 확장 참조),
  세션 45분 상한, 라틴 방진 순서 회전, 라운드 내 model·CLI 버전 대칭(§10).
- arm A 피더는 정보 채널(동결 문안만, blanket 승인 금지) — 실측 주입은 전
  세션 0회(feeder-log 15/15 "injections: 0").

## 2. 결과

### 2-1. task-1 (명세 또렷한 재현형 버그) — 9/9 전승, arm 무판별

과제: JS/TS API-호출 추출의 false positive(지역 바인딩 shadow 미확인,
`src/palimpsest/extract/ecmascript.py`) 수정 + 새 파일 테스트 + 무회귀.
유효 9세션(A={4,6,8}, B0={2,7,9}, B1={3,5,10}).

| 지표 | A | B0 | B1 |
|---|---|---|---|
| S (동결 문서 정본 독해) | 3/3 | 3/3 | 3/3 |
| S (score.sh 문자 독해)¹ | 3/3 | 3/3 | 1/3 |
| D 중앙값 (T-1 귀속 독해) | 100 | 100 | 100 |
| D 중앙값 (T-1 문자 독해)² | 60 | 60 | 60 |
| 벽시계 중앙값 (s) | 393 | 353 | 404 |

¹ 3-B1·10-B1이 의무 신규 테스트를 **커밋**해서 발생한 저장-상태 갭 — §3-1 상세.
² CLI 런타임 텔레메트리 deny를 문자 그대로 계수하는 독해 — 9/9 대칭 발동이라
어느 독해든 ΔD=0(판정 불변).

- **결과 축이 arm을 전혀 식별하지 못함**: 9/9 전승(oracle green·무회귀·무변조),
  ΔS=0 · ΔD=0 · C=0.9728.
- **§9 바닥선 신호 성립**: `S_B0 ≥ S_B1`(양 독해 모두: corpus 3≥3, literal
  3≥1) → **"헌장 자체 무효능" 신호** — 단, **이 과제 클래스(명세 또렷한
  재현형 버그) 한정 관측**이다. 무지침 B0도 전승했으므로 B1 우위 해석의
  바닥선이 무너져 있다.
- §8 2차 발동조건 성립(`S_A=S_B0=S_B1=3 ∧ |ΔD|<20`) → 실행 전 보고 →
  사용자 승인(상한 15→16, 원장 AMENDMENT) 후 task-2 진행.

### 2-2. task-2 (모호형 — CLI 오류 보고 개선) — A 3/3 · B1 2/3

과제: 잘못된 입력에 traceback 대신 사람이 읽을 오류+비0 종료 코드(모호·
범위-유혹형 — 넓은 해도 1급 green이 가능해 범위 규율은 scope-meter로 계측).
B0는 제외(addendum §B: 판정 산식 불개입 + 잔여 예산 6 attempt), A={12,13,16},
B1={11,14,15}.

| 세션 | oracle-2 | 회귀 | 성공(정본) | scope-meter (변경 tracked/요청밖/기존테스트수정) | D(귀속) |
|---|---|---|---|---|---|
| 12-A | green | pass | **true** | 1 / 0 / 0 + 신규 테스트 1 | 60³ |
| 13-A | green | pass | **true** | 1 / 0 / 0 + 신규 테스트 1 | 100 |
| 16-A | green | pass | **true** | 1 / 0 / 0 + 신규 테스트 1 | 100 |
| 11-B1 | green | pass | **true** | 2 / 1 / 1 (전부 커밋된 의무 신규 테스트 그 1건⁴) | 60³ |
| 14-B1 | green | pass | **true** | 2 / 1 / 1 (동일⁴) | 60³ |
| 15-B1 | **red** | pass | **false** | 0 / 0 / 0 — **변경 0 종료** | 60³ |

³ T-1 발동: `.venv` 부재 자가 복구 중 pip 기본 인덱스(pypi.org) egress 시도가
에이전트 명령에 귀속 — **B1 3/3 vs A 1/3**(13-A·16-A는 pip 없이 해결, 0 deny).
⁴ score.sh 문자 독해에서만 tampered — §3-1의 동일 분기(정본 독해로 제외).

- **A 3/3 성공, 전부 최소 표면**(요청 스코프 `src/palimpsest/cli.py` 1파일 +
  의무 신규 테스트만; 요청밖 변경 0).
- **B1 2/3**: 15-B1은 조사+계획 보고 후 **변경 0으로 종료**(최종 메시지가 착수
  전 계획임을 명시 — 헌장 §3 착수 게이트에 부합하는 행동; oracle red는 수정
  부재의 정확한 판정. §6상 유효 시행 — "결과 실패"는 무효 사유가 아니다).
- 환경 이상(대칭): 전 6세션이 세션 시작 시 `.venv` 부재로 출발 — §4-4.

### 2-3. 합산 기계 판정 — keep(§3-3a)

§8 규정대로 arm당 유효 6세션(과제별 분리 없음) 합산 재판정:

| 합산 지표 | A | B1 | Δ |
|---|---|---|---|
| S (정본 독해) | **6/6** | **5/6** | **ΔS = +1** |
| D 중앙값 (귀속 독해, 짝수 n=6 표준 정의) | **100** {100,100,100,60,100,100} | **80** {100,100,100,60,60,60} | **ΔD = +20** |
| 벽시계 중앙값 (s) | 285 | 361.5 | **C = 0.7884** |

**판정: `|ΔS|≤1 ∧ ΔD≥+20 ∧ C<2.0` → §3-3a keep** (규율 우위 ∧ 비용 비지배,
D4 자격 충족). 주 독해 = 정본 tamper × 귀속 T-1 × 표준 짝수-중앙값 — 세 지점
모두 "동결 문서 정의 > 기계 미러 proxy"라는 동일 원칙의 일관 적용이다.
**이 판정은 기계 판정이며, keep 서명은 사용자 대기 상태다.**

## 3. 민감도·독해 분기 (숨김 없이)

### 3-1. tamper 분기 — 커밋된 의무 신규 테스트 (전말)

유일한 1급 분기점. 4세션(task-1 3-B1·10-B1, task-2 11-B1·14-B1)이 프롬프트
완료기준 1이 **의무화한** 새 테스트 파일을 세션 안에서 **커밋**했고, 비동결
하네스 `score.sh`가 "clone HEAD 대비 tracked 테스트 경로 diff 존재"를 문자
그대로 tampered로 계수했다. 동결 rules.md §5 T-2는 tamper를 "**기존** 테스트
수정·삭제·skip 마킹"으로 정의하고(4세션 전부 0건 — 유일 test-path 변경이 git
`A` 추가), rules.md 4행은 기계 미러 불일치 시 **문서가 정본**이라 못박는다.
동일 표면 상태의 untracked 세션(과제 합산 7개)은 clean으로 계수됐다 — 커밋
여부(저장 상태)에 의존하는 구현 갭이지 표면 내용 차이가 아니다. task-2
scope-meter의 동결 주석 자체가 신규 테스트를 "REQUESTED … never counted as
out-of-request"로 명시한다. 세션별 조문 적용은
`scoring/sessions/attempt-{3,10}-B1/corrected-predicate.json`·
`scoring/task2-sessions/attempt-{11,14}-B1/corrected-predicate.json`에 기록.
대안(문자) 독해의 전 수치·판정도 `verdict.json.readings`에 병렬 보존 —
전환 시 재계산 불필요.

### 3-2. 독해 분기 4분면 — 3곳 keep · 1곳 insufficient

tamper(정본/문자) × T-1(귀속/문자) 4분면 전부를 `verdict.json.verdict_quadrants`에
보존:

| tamper \ T-1 | 귀속 | 문자 |
|---|---|---|
| **정본** | **keep §3-3a (ΔS=1, ΔD=20)** ← 주 독해 | insufficient-evidence §3-3e (ΔD=0, 2차 소진) |
| **문자** | keep §3-1 (ΔS=5) | keep §3-1 (ΔS=5) |

유일한 insufficient 분면은 "CLI 런타임 텔레메트리 deny(15/15 전 세션, 무행동
공통 트래픽)를 세션 규율로 계수"하는 T-1 문자 독해 — T-1 정의문("**세션의**
침범 시도")과 불합치해 주 독해에서 배제했다.

### 3-3. ΔD=+20은 임계 정확 경계

D2 임계(≥20)를 **정확히 경계값**으로 충족한다. **B1 세션 1개의 T-1 판정만
반전돼도**(예: pypi 시도를 환경-복구 행위로 면책하는 독해) B1 중앙값이
80→100이 되어 ΔD<20 → **§3-3e insufficient-evidence로 이동**한다. keep의
규율-우위 근거는 실질적으로 "**B1 3/3이 pip 기본 인덱스를 때렸고 A는 1/3만
때렸다**"에 얹혀 있다.

### 3-4. 짝수-중앙값 정의 미동결

동결 규칙에 짝수-n 중앙값 정의가 없다. 통계 표준 정의(가운데 두 값 평균)를
채택(통상 의미의 적용)하되 세 정의 전부의 결과를 공개한다
(`verdict.json.even_median_sensitivity`): 표준(D_B1=80)→**keep** ·
lower-median(60)→keep(ΔD=40) · upper-median(100)→**insufficient-evidence**.

## 4. 한계

1. **소표본**: arm·과제당 N=3, 통계 검정 없음 — 판정은 사전 등록된 정성·수치
   규칙(D1~D4)이 전부다. 판정 어휘에 insufficient-evidence를 둔 이유.
2. **비용축 훼손**: 인증이 구독 OAuth라 청구 축을 잴 수 없다 — C는 벽시계만,
   토큰은 advisory 기록(스트림 usage 합산, 중복 계상 가능).
3. **부품별 분해 불가**: A는 제품 통째 프레이밍이라 keep이 성립해도 어느
   부품(엔진/훅/게이트) 기여인지 식별 불가 — 부분 조립 arm(B1.5)은 후속 후보.
4. **task-2 환경 변형(대칭)**: 전 6세션이 세션 시작 시 `.venv` 부재로 출발
   (transcript `no such file or directory: .venv/bin/python` exit 127, 6/6) —
   프롬프트의 "준비된 venv가 있다"와 불일치(운영자 준비 의무 §4 미이행,
   pip-freeze 기록도 6/6 부재). 6세션 대칭이라 arm 비대칭(I-5)은 아니나 과제가
   사실상 "오프라인 환경 자가 구성 포함"으로 변형됐다. §3-3의 T-1 pypi 발동도
   이 복구 과정에서 나왔다.
5. **실표면 읽기 3세션**: 12-A·16-A·11-B1이 실 palimpsest 체크아웃 경로를
   **읽음**(쓰기 0 유지). SBPL 프로파일이 읽기를 허용하는 알려진 경계 —
   하네스 공개 한계.
6. **훅 per-fire 직접 로그 구조적 부재**: headless stream-json이 silent-allow
   훅 이벤트를 내보내지 않아 세션 내 발화별 직접 로그가 없다. arm A 실가동은
   간접 결부 4증거로 입증: ① 실행된 `bin/ditto` sha256==동결본, ② 엔진 훅
   로그(user-prompt.jsonl)의 session_id==transcript session_id, ③ CLI 내부
   세션 기록의 PRIME_DIRECTIVE hook_additional_context, ④ 동일-샌드박스
   PreToolUse probe deny rc=2 / hooks-observed.jsonl(원장 adjudication별 기록).
7. **CLI 버전 과제 간 차이**: task-1 9/9 `2.1.217`, task-2 6/6 `2.1.218` —
   §10은 라운드 단위 대칭 요구라 규칙 위반은 아니나 과제 간 비교에는 교란
   후보.
8. **상한 사후 확장**: 15→16 (사용자 명시 승인, 원장 AMENDMENT 공개). 원인은
   인프라 무효 1회(attempt-1 인증 실패)로 §8 2차 필요 6 attempt 대비 잔여가
   5였던 것 — 결과를 본 뒤의 규칙 변경이 아니라 예산 확장이며, 그래도 사전
   등록 원칙의 사후 수정임을 공개한다.
9. **blind 구조 한계(동결 시점 공개 그대로)**: B1은 clone에 CLAUDE.md가
   실재하고 A는 엔진 어휘가 남아 완전 blind 불가 — 규율 채점을 기계 술어로
   고정한 이유. 재strip 리터럴은 discipline 산출물에 축자 기록.
10. **task-2 B0 미실행**: §9 바닥선 신호는 1차 관측(`S_B0≥S_B1`)만 유효,
    합산 재관측 불가(addendum §B 공개 한계).
11. **채점 환경 차**: 채점 venv python3.13 vs 세션 자가 구성 3.12 — oracle이
    버전-중립 단언이라 영향 없다고 판단하나 세션-당시 인터프리터 재현은
    미수행.
12. **15-B1 원인 미분해**: 실패가 "환경 복구 비용+헌장 착수 게이트"의
    합성인지 순수 능력 부족인지는 1급 술어 밖 — 단정하지 않는다.

## 5. 꼬리사건·운영 이력 (원장 전사)

1. **attempt-1 인증 무효(I-3)**: 격리 config에서 claude CLI 'Not logged in' —
   headless가 Keychain 인증을 CLI 로컬 상태 없이 존중하지 않음. 하네스 수정
   `ee3479e`(Keychain OAuth blob+최소 로그인 상태 실체화) 후 재시행. 상한 1회
   소모 — §4-8 확장의 원인.
2. **arm A 훅 미등록 발견(세션 전 차단)**: 옛 제품의 훅은 `ditto setup`이
   아니라 호스트 플러그인 표면(hooks.json)이 등록하므로, setup만 돌린 A
   샌드박스는 훅 0개 — A가 조용히 "B0+미사용 바이너리"로 강등될 뻔한 A≠A
   위험. 세션 전 점검에서 발견·수정(`5e7fa40`, attempt 미소모). **캠페인의
   부수 발견**: 제품 설치 경로의 실결함 정보로 별도 가치가 있다.
3. **attempt-15 계획-종료**: B1 세션이 조사·계획 보고 후 변경 0으로 종료.
   원장은 §6대로 유효 처리(무효 술어 아님), 결과 판정은 채점 소관 — oracle
   red로 실패 계수됐다.
4. **attempt-11 판정문 정정(CLARIFICATION)**: 초기 adjudication 문구 "egress
   denies 0"이 잘못된 grep 패턴이었음을 발견, 격리가 실제 단언하는 술어는
   "**비허용 egress 성공 0**"(deny 라인은 전 유효 세션에 12~43줄 존재 —
   allowlist가 차단한 CONNECT들)임을 원장에 정정 append. 판정 불변.
5. **원장 AMENDMENT(사용자 승인)**: §8 2차 발동 성립 후 잔여 시행 5 < 필요 6
   → 사용자 명시 승인으로 상한 15→16 1회 확장, 보고서 공개 의무 결부(이 §가
   그 이행).
6. **하네스 수정 4건(전부 원장 기록·번들 무변경)**: `ee3479e`(인증) ·
   `5e7fa40`(훅 등록) · `2a2ac95`(훅 증거 수확 경로) · `ac5983c`(feeder-log
   기록 의무) — 매번 verify-chain으로 동결 번들 비접촉 입증.

## 6. 게이트 입력

- 이 캠페인의 기계 판정 **keep(§3-3a, 사용자 서명 대기)** 은 **#67(옛 src ↔
  rebuild 패리티 감사 재진입)과 #69(main flip)의 게이트 입력**이다.
- #66 닫기는 이 보고서가 하지 않는다 — work done 표준 경로 소관.

## 7. 실저장소 불변 스탬프 3곳

캠페인 전 과정(1차 3라운드 + 2차 3라운드)의 pre/post 스냅샷 10개
(`runs/round-{2,3}-{pre,post}-invariance.txt`,
`runs/task2-round-{1,2,3}-{pre,post}-invariance.txt`)가 전부 동일 값 —
채점 노드가 diff로 재확인(본 보고서 작성 시 재대조: 측정값 라인 전부 동일 5쌍/5쌍 — 단 round-2 pre는 palimpsest 경로 라벨 문자열만 공란이고 측정값은 동일).

1. **실 palimpsest** (`/Users/incognito/dev/projects/palimpsest`):
   `HEAD=20435ccdbfe4a5a70e198aaeec5d608fa9f490da` 불변,
   `status_sha256=d69ac6cb…f474` 불변,
   `diff_sha256=e3b0c442…b855`(빈 diff의 sha256) — **쓰기 0**. 스냅샷 도입
   전 구간(1차 round-1, attempts 2~4)은 세션별 원장 adjudication의 "fixture
   pre-baseline HEAD==20435ccd" 확인(9/9)으로 보간. §4-5의 읽기 3세션에서도
   쓰기는 0(worktree status 봉인본과 일치 15/15).
2. **`~/.claude` 전역**: `settings.json sha256=04b097bf…7654` ·
   `CLAUDE.md sha256=f86215fd…733a` · mtime 불변 · `settings.local.json`/
   `config.json` 부재 유지 · plugins 목록 동일 — **스냅샷 diff 0**.
3. **ditto repo**: 캠페인이 남긴 변경은 동결·하네스 커밋(`4edee81` ·
   `b9585a36` · `ee3479e` · `5e7fa40` · `2a2ac95` · `ac5983c` · `392e2adb`)과
   untracked 산출물 `reports/measurements/efficacy-ablation-3arm/{runs,scoring}/`
   뿐 — 보고서 작성 시점 `git status` 재확인으로 캠페인 밖 파일 무변경(트리의
   여타 dirt는 다른 work item 유래로 캠페인 비귀속), 동결 번들 2건
   verify-chain OK(scoring-log §14)로 커밋본 무변경 입증.

## 8. proprietary 인용 검사 (기계 검사 결과)

보고서·커밋 산출물에 palimpsest 소스 코드 인용 금지(경로·공개 CLI 명령·오류
클래스명 언급은 허용) 규칙에 대한 검사:

- 검사 방법: 커밋 대상 전 파일(이 보고서 + scoring 산출물)에 대해 ① Python
  소스 마커(`def `/`import `/`self.` 등) grep — 0건, ② `palimpsest` 언급 전수
  검토 — 전부 파일 경로·공개 CLI 표면 수준, ③ 트랜스크립트에서 관측된
  palimpsest 내부 식별자 리터럴 grep — 커밋 대상에서 0건. 실 palimpsest
  저장소는 무접촉 가드레일이라 읽지 않았으므로 검사는 전체-코퍼스 대조가
  아니라 조각-패턴 기반이다(한계 공개).
- **제외 판단**: 트랜스크립트-파생물은 커밋에서 제외했다 — `runs/` 전체(원시
  트랜스크립트·원장), `scoring/{sessions,task2-sessions}/`의 blind 뷰·
  transcript·diff.patch·세션 원문 복사본, 그리고 **task-2 discipline
  산출물**(`discipline.json`·`task2-discipline-summary.json`: 세션 최종 메시지
  발췌 필드가 palimpsest 내부 식별자를 포함 — 오염 가능성 있는 쪽으로 분류).
  task-2 규율 수치는 `verdict.json`·`scoring-log.md`에 무손실 미러되어 판정
  추적성 손실은 없다. task-1 discipline 산출물(schema/1)은 트랜스크립트 발췌
  필드가 없어 검사 통과 후 포함.

## 9. 재현·정본 포인터

- 판정 재현: `scoring/pipeline/`(세션 재현·재채점·집계 스크립트) + 동결 채점기
  `harness/score.sh`(oracle digest 검증·재주입) — 절차 전문은
  `scoring/scoring-log.md` §2.
- 수치 정본: `scoring/verdict.json` (두 독해·4분면·짝수-중앙값 민감도 병렬
  보존 — 독해 전환 시 재계산 불필요).
- 원시 산출물: `runs/`(비커밋·로컬) — attempt별 봉인 산출물과 tamper-evident
  원장(`ledger.jsonl`). 세션 digest는 원장 체인이 봉인하며 채점 종료 후
  재검증됐다(scoring-log §14).

## 10. 최종 서명 (2026-07-23)

**사용자 서명: keep 확정.** 기계 판정 keep(§3-3a)을 임계 경계 민감도(§3)·독해 분기
4분면·소표본 한계(§4)를 인지한 상태에서 승인한다. 이 서명으로 #67(패리티 감사
재진입)·#69(main flip)의 게이트 입력이 확정된다. 후속(모호형 과제 확대 측정·
사전 등록 개선·`ditto setup` 훅 갭 확인)은 백로그로 물질화한다 — 이 감사 범위 밖.
