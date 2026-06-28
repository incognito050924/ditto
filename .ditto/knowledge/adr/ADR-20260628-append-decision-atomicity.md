# ADR-20260628-append-decision-atomicity: autopilot 결정 로그는 O_APPEND 단일쓰기 + single-writer로 충분 — 파일 락 불필요

- 상태: accepted
- 결정 일자: 2026-06-28
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: wi_260627jhh(컨텍스트 관리 강화) track C(ac-7)에서 appendDecision을 read-then-rewrite에서 atomic O_APPEND로 전환(621d893). 코드(권위): `src/core/autopilot-store.ts` appendDecision(`appendFile(path, json+'\n', flag 'a')`)·recordResult single-writer(R7) 주석, `src/core/autopilot-loop.ts` recordResult(직렬 record-result), `.ditto/local/work-items/<wi>/active-leases.json`(리스). idiom: `memory-warmstart.ts:116`. **supersede 없음.**

## 컨텍스트

readDecisions의 O(N) 누적을 증분화하면서(wi_260627jhh ac-7), appendDecision의 기존 read-then-rewrite를 atomic O_APPEND(`appendFile` flag 'a')로 바꿔 in-process lost-update 레이스를 해소했다.

후속 위험 리뷰에서 "O_APPEND가 *멀티프로세스* 동시 append에서도 원자적인가 — 큰 버퍼가 여러 write() 호출로 쪼개지면 두 appender가 interleave할 수 있다"를 잠재 위험으로 제기했다. 이를 추정으로 남기지 않고 코드로 검증했다.

## 결정

**appendDecision의 O_APPEND 단일쓰기는 충분하다 — 파일 락이나 교차 프로세스 동기화를 추가하지 않는다.** 멀티프로세스 interleave의 전제 자체가 성립하지 않으므로 not-a-defect로 닫는다.

## 근거 (rationale)

코드로 검증한 근거(§4-11, 본문에 직접):

- **레코드는 작은 단일 write 페이로드다.** `appendFile(path, `${JSON.stringify(decision)}\n`, flag 'a')` 한 번 호출이고, AutopilotDecision은 작은 JSON(수 KB 미만)이다. 이 크기는 OS의 단일 write() 한 번으로 처리되며, regular file + O_APPEND에서 offset-갱신-및-쓰기는 write() 호출 단위로 원자적이다. interleave는 버퍼가 여러 write()로 분할될 만큼 클 때만 발생하는데, 그 전제가 없다.
- **같은 work item의 append는 직렬화된다.** appendDecision은 recordResult 안에서 호출되고, recordResult는 single-writer(R7)로 직렬화된 record-result 경로다(`autopilot-loop.ts`·`autopilot-store.ts` R7 주석). 한 autopilot run 내에서 두 append가 동시 발생하지 않는다.
- **교차 프로세스 동시 구동은 상위에서 막힌다.** 같은 work item을 두 `ditto autopilot` 프로세스가 동시에 구동하는 것은 `active-leases.json` 리스 모델이 차단한다. 따라서 "같은 결정 로그에 두 프로세스가 동시 append"하는 상황 자체가 발생하지 않는다.
- **종합:** interleave의 두 전제(① 같은 로그 동시 append, ② write() 분할될 큰 레코드)가 모두 거짓이다. O_APPEND 전환은 그것이 실제로 고친 버그(in-process read-then-rewrite lost-update)를 제거했고, 그 너머의 가드는 불필요한 복잡도다(§4-3).

기각된 대안:

- **flock/파일 락 또는 교차 프로세스 큐** — 발생하지 않는 시나리오(리스로 차단)를 위한 방어 복잡도. 현재 계약상 일어날 수 없는 상황용 fallback은 금지된다(§4-3, 헌장 §4-3).
- **"열린 위험"으로 보류** — 미루기(§4-8). 코드로 검증해 not-a-defect로 닫는 것이 정직하다.

## 변경 조건 (change_condition)

(a) 결정 레코드가 OS 단일 write 한계를 넘을 만큼 커지거나, (b) 같은 work item의 결정 로그에 동시 append하는 다중 프로세스가 리스 모델 밖에서 가능해지면 재검토한다 — 그때 비로소 write() 분할 interleave가 실재 위험이 되어 락/세그먼트화를 저울질한다.
