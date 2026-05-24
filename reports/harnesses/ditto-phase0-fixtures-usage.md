# DITTO Phase 0 Fixture Usage Notes

상태: 임시 설명 문서.

이 문서는 `reports/harnesses/ditto-application-plan.md` 4장 Phase 0가 만든 계약과 fixture를 설명한다. 정식 설계 문서라기보다는, 나중에 이 저장소를 다시 열었을 때 "이 많은 `.ditto` 파일이 왜 있는가"를 떠올리기 위한 안내문이다.

소비자는 Phase 0/1 이후 구현을 이어받는 agent, fixture를 고치는 사람, schema 변경을 리뷰하는 사람이다. schema 필드, `.ditto` 디렉터리 구조, fixture 파일, completion/handoff 규칙이 바뀌면 같이 갱신한다. 같은 내용이 ADR이나 정식 설계 문서로 승격되면 이 임시 문서는 삭제한다.

## 먼저 장면을 하나 잡자

사용자가 이렇게 말했다고 하자.

> 사용자 등록 API에 비밀번호 강도 검증 추가해줘.

평범한 작업처럼 보인다. 구현자는 `src/api/users.ts`를 고치고, 테스트를 추가하고, 마지막에 "완료했습니다"라고 말할 수도 있다.

DITTO가 막으려는 것은 바로 그 너무 쉬운 마지막 문장이다.

"완료했습니다"라는 말은 편하지만, 다음 사람이 이어받을 때는 별 도움이 되지 않는다. 무엇을 고쳤는지, 어떤 기준으로 통과라고 봤는지, 어떤 테스트가 실제로 돌았는지, 무엇은 아직 모르는지, 다음에 어디서 시작해야 하는지까지 남아 있어야 한다.

Phase 0는 이 질문에 답하려고 시작했다.

> 작업이 끝났다고 말하려면, 최소한 어떤 파일들이 있어야 하는가?

그래서 Phase 0는 실행 기능보다 먼저 파일 계약을 만들었다. 작업을 담는 파일, 실행을 담는 파일, 검증을 담는 파일, 완료 주장을 담는 파일, 용어를 담는 파일이다. 이 계약들이 지금의 `.ditto` 구조다.

## DITTO가 기억하는 방식

DITTO는 대화창을 믿지 않는다. 대화는 사라지고, context window는 잘리고, 사람은 중간 과정을 잊는다. 그래서 DITTO는 작업의 중요한 부분을 파일로 옮긴다.

한 작업은 `.ditto/work-items/<id>/work-item.json`에서 시작한다. 여기에 원래 요청, 목표, acceptance criteria, 현재 상태가 들어간다. 이 파일이 없으면 DITTO는 "무슨 작업이었는지" 모른다.

provider를 한 번 실행하면 `.ditto/runs/<id>/manifest.json`이 생긴다. 여기는 그 실행이 어떤 provider로, 어떤 profile로, 어떤 git 상태에서 시작했고, 어떤 stdout/stderr/diff를 남겼는지 적는다. 이 파일이 없으면 DITTO는 "무슨 일이 실제로 일어났는지" 모른다.

검증 명령을 돌리면 `.ditto/work-items/<id>/evidence/commands.jsonl`에 한 줄씩 쌓인다. exit code, 실행 시각, 어떤 acceptance를 확인하려 했는지가 남는다. 이 파일이 없으면 DITTO는 "무슨 근거로 pass라고 했는지" 모른다.

마감할 때는 `.ditto/work-items/<id>/completion.json`이 만들어진다. 여기에는 acceptance별 verdict, evidence, 남은 unverified, remaining risk가 들어간다. 이 파일이 없으면 DITTO는 "완료 주장이 정당한지" 판단하지 못한다.

마지막으로 사람이 읽는 `.ditto/work-items/<id>/handoff.md`가 있다. JSON 파일들은 정확하지만 읽기에는 느리다. handoff는 다음 agent가 바로 볼 수 있는 요약이다. 무엇이 끝났고, 무엇이 남았고, 어디서 이어받아야 하는지를 말한다.

이 흐름을 작은 이야기로 쓰면 이렇다.

1. `work-item.json`이 작업의 이름표를 붙인다.
2. `manifest.json`이 실행의 발자국을 남긴다.
3. `commands.jsonl`이 검증의 영수증을 쌓는다.
4. `completion.json`이 "정말 끝났나"를 묻는다.
5. `handoff.md`가 다음 사람에게 길을 알려준다.

Phase 0 fixture는 이 다섯 파일이 서로 어떻게 기대야 하는지를 보여준다.

## Schema는 문서가 아니라 문지기다

처음 보면 `src/schemas/*.ts`는 단순한 타입 정의처럼 보인다. 하지만 현재 구현에서 schema는 파일을 쓰고 읽는 문지기다.

`WorkItemStore.create()`는 `work-item.json`을 만들기 전에 `workItem` schema를 통과시킨다. 동시에 빈 `language-ledger.json`도 만든다. 작업이 시작되면 상태 파일과 용어 기록 파일이 같이 생기는 셈이다.

`RunStore.create()`는 `manifest.json`을 `runManifest` schema로 검증한다. provider 실행 기록이 빠진 필드나 잘못된 id를 가진 채 저장되지 않도록 막는다.

`EvidenceStore.appendCommand()`는 `commands.jsonl`에 새 줄을 넣기 전에 `commandLogEntry` schema를 통과시킨다. 검증 명령 로그가 대충 적힌 문자열 더미가 되지 않게 한다.

`writeWorkItemHandoff()`는 `completionContract` schema로 마감 주장을 검사한다. 여기서 중요한 규칙이 나온다.

`final_verdict=pass`라고 말하려면 모든 acceptance가 `pass`여야 한다. 그리고 scope 안의 `unverified`가 남아 있으면 안 된다. 반대로 `partial`, `fail`, `unverified`처럼 pass가 아닌 상태라면 `next_handoff_path`가 있어야 한다.

이 규칙 때문에 DITTO에서는 "테스트는 못 돌렸지만 완료" 같은 문장을 파일로 남기기 어렵다. 말로는 할 수 있어도, schema가 받아주지 않는다.

## CLI가 이 파일들을 움직인다

지금의 CLI는 아직 완성형은 아니지만, Phase 0 계약을 실제로 사용한다.

`ditto work start`를 실행하면 새 work item이 생긴다. `work-item.json`에는 요청과 목표가 들어가고, 첫 acceptance는 `unverified`로 시작한다. 같은 디렉터리에 `language-ledger.json`도 생긴다. 작업은 아직 아무것도 증명하지 않았다. 그래서 상태도 조심스럽게 시작한다.

`ditto work status`는 그 파일을 읽는다. human 출력은 사람이 보기 좋게 줄여 보여주고, JSON 출력은 schema를 통과한 객체를 그대로 내보낸다.

`ditto verify <workId> --criterion <ac> -- <command...>`는 실제 명령을 실행한다. 결과는 `commands.jsonl`에 남는다. criterion을 지정했다면 exit 0은 `pass`, non-zero는 `fail`로 acceptance verdict가 바뀐다. 여기서 중요한 점은 verdict가 말이 아니라 command evidence를 따라 움직인다는 것이다.

`ditto run record`는 이미 일어난 provider 실행을 수동으로 run manifest에 붙인다. 만든 run id는 work item의 `runs` 배열에 연결된다.

`ditto run with`는 한 걸음 더 나간다. provider command를 직접 spawn하고, stdout/stderr/diff를 파일로 저장하고, manifest에 exit code와 changed files를 적는다. profile이 `read-only`나 `reviewer`인데 파일 변경이 감지되면 그 사실도 `unverified`에 남긴다. `isolated` profile이면 per-run worktree path도 manifest에 기록한다.

`ditto work handoff`는 현재 work item을 보고 마감 파일을 만든다. 모든 acceptance가 pass이고 in-scope unverified가 없으면 status를 `done`으로 닫는다. 그렇지 않으면 status를 `partial`로 두고, 다음에 어떤 fresh evidence가 필요한지 `re_entry`와 `handoff.md`에 남긴다.

여기까지가 현재 구현이 실제로 하는 일이다. Phase 0의 파일 계약은 이미 CLI와 store의 작동 경로 안에 들어와 있다.

## Context packet은 다음 실행을 위한 봉투다

작업을 한 번에 끝내지 못하면 다음 실행이 필요하다. 그때 provider에게 무엇을 줘야 할까.

현재 `buildContextPacket()`은 work item, linked runs, git state를 읽어 `.ditto/work-items/<id>/context-packet.md`를 만든다. 아직은 단순하다. title, goal, acceptance criteria, git state, run별 exit code 정도를 담는다.

하지만 방향은 분명하다. 완성된 DITTO에서 context packet은 provider에게 건네는 봉투가 된다. 그 안에는 목표, acceptance, 이전 실패, evidence pointer, 건드리지 말아야 할 파일, 기대 출력 계약이 들어간다.

Phase 0 fixture는 이 봉투가 어디서 재료를 가져와야 하는지 보여준다. `work-item.json`에서 목표를 가져오고, `manifest.json`에서 이전 실행을 가져오고, `handoff.md`에서 이어받을 지점을 가져오고, `glossary.json`에서 용어를 가져온다.

## Golden fixture는 왜 password-strength인가

위치:

```text
tests/fixtures/scenarios/password-strength/.ditto/
```

이 fixture는 성공담이 아니다. 일부러 조금 덜 끝난 작업이다.

비밀번호 강도 검증은 추가됐다. 약한 비밀번호는 400을 반환하고, 강한 비밀번호는 201을 반환한다. 여기까지는 pass다. 그런데 정책 위반 메시지가 규칙별로 분리되어야 한다는 acceptance는 아직 partial이다. 메시지는 있긴 하지만 한 줄로 합쳐져 있다.

이 어정쩡한 상태가 중요하다.

완전히 성공한 fixture만 있으면 DITTO가 진짜로 필요한 순간을 설명하지 못한다. 실제 작업은 자주 이렇게 끝난다. 대부분은 되었지만, 일부 검증이 남고, 다음 사람이 이어받아야 한다.

`password-strength` fixture는 바로 그 순간을 박제한다. "여기까지 했다. 여기부터 다시 봐라. 이 명령을 돌렸고, 이 evidence가 있고, 이 acceptance는 아직 만족하지 못했다." 이 말을 파일 묶음으로 표현한 것이다.

## password-strength 디렉터리를 걸어가 보자

전체 모양은 이렇다.

```text
tests/fixtures/scenarios/password-strength/.ditto/
  knowledge/
    CONTEXT.md
    glossary.json
  work-items/
    wi_pwdcheck/
      work-item.json
      progress.md
      decisions.md
      handoff.md
      completion.json
      language.md
      language-ledger.json
      evidence/
        commands.jsonl
      reviews/
        rv_pwdcheck1.json
  runs/
    run_pwdcheck1/
      manifest.json
      prompt.md
      result.md
      stdout.log
      stderr.log
      diff.patch
```

아래 설명은 파일을 위에서 아래로 훑는 순서가 아니라, 작업을 이해하는 사람이 실제로 따라갈 법한 순서로 쓴다.

## 1. `work-item.json`: 이 일이 무엇이었나

처음 열어볼 파일은 `work-items/wi_pwdcheck/work-item.json`이다.

여기에는 사용자의 원래 요청이 들어 있다. "사용자 등록 API에 비밀번호 강도 검증 추가해줘." 그 요청은 DITTO 안에서 goal과 acceptance criteria로 바뀐다.

goal은 결과를 말한다. POST `/users` 요청에서 비밀번호가 정책에 미달하면 400과 명시적 메시지를 반환해야 한다.

acceptance criteria는 그 goal을 쪼갠 관찰 가능한 기준이다.

- 짧은 비밀번호면 400을 반환한다.
- 정책을 통과한 비밀번호면 201을 반환한다.
- 정책 위반 응답 body에 어떤 규칙이 깨졌는지 사람이 읽을 수 있는 메시지가 들어간다.

fixture에서는 앞의 둘은 `pass`, 마지막 하나는 `partial`이다. 그래서 work item 전체 status도 `partial`이다.

이 파일의 핵심은 `re_entry`다. partial 상태라면 다음 사람이 무엇을 해야 하는지 반드시 있어야 한다. fixture의 `re_entry`는 `ditto work resume wi_pwdcheck`와 fresh evidence 목록을 남긴다. "ac-3 메시지 분리 결과"와 "기존 사용자 영향 회귀 테스트"가 다음 증거로 적혀 있다.

현재 구현에서는 `WorkItemStore`가 이 구조를 읽고 쓴다. `work status`, `verify`, `handoff`, `context packet`도 이 파일을 중심으로 움직인다.

완성된 DITTO에서는 scheduler와 workflow loop가 이 파일을 먼저 읽을 것이다. status가 `partial`이면 새 provider 실행을 바로 반복하지 않고, fresh evidence가 무엇인지 확인해야 한다.

## 2. `manifest.json`: 실제로 무슨 실행이 있었나

work item이 "무엇을 하려 했는지"라면, `runs/run_pwdcheck1/manifest.json`은 "실제로 어떤 실행이 있었는지"다.

여기에는 provider가 `claude-code`였고, profile이 `workspace-write`였고, 어떤 git commit에서 시작했는지가 남아 있다. 실행 후에는 working tree가 dirty가 되었고, 세 파일이 바뀌었다.

`stdout_path`, `stderr_path`, `diff_path`도 여기서 연결된다. manifest는 큰 로그를 품지 않는다. 대신 어디에 있는지 가리킨다. context를 아끼기 위해서다.

또 하나 중요한 부분은 `verifications`와 `unverified`다. weak-password 테스트와 strong-password 테스트는 exit 0이다. message-includes 테스트는 exit 1이다. 그래서 ac-3이 partial이 된다.

현재 구현에서는 `RunStore`와 `ditto run record`, `ditto run with`가 이 형태를 사용한다. `context packet`도 linked run의 exit code를 읽는다.

완성된 DITTO에서는 manifest가 retry 판단의 근거가 된다. 같은 실패를 fresh evidence 없이 반복하고 있는지, profile이 약속한 권한을 어겼는지, artifact capture가 실패했는지 여기서 본다.

## 3. `commands.jsonl`: 어떤 명령이 증거였나

`work-items/wi_pwdcheck/evidence/commands.jsonl`은 검증 명령의 영수증 묶음이다.

각 줄은 하나의 JSON이다. 명령, exit code, 실행 시간, 관련 work item, 관련 acceptance criterion이 들어간다. 한 파일 전체가 JSON array가 아닌 이유는 append하기 쉽기 때문이다.

이 파일이 필요한 이유는 단순하다. acceptance에 `pass`라고 적혀 있어도, 무슨 명령으로 확인했는지 없으면 믿기 어렵다.

현재 구현에서는 `ditto verify`가 이 파일을 쓴다. `EvidenceStore.appendCommand()`는 한 줄을 쓰기 전에 schema 검증을 한다. fixture test도 줄마다 파싱해서 깨진 로그가 없는지 확인한다.

완성된 DITTO에서는 evaluator가 completion claim을 볼 때 이 로그와 대조한다. "ac-1 pass"라는 주장 옆에 실제 command evidence가 있는지 확인하는 식이다.

## 4. `completion.json`: 정말 끝났다고 말할 수 있나

`completion.json`은 DITTO에서 가장 까다로운 파일이다.

사람이 읽는 요약도 있고, 바뀐 파일도 있고, acceptance별 verdict도 있다. 하지만 핵심은 cross-field rule이다.

`final_verdict=pass`라고 쓰려면 모든 acceptance가 pass여야 한다. 그리고 scope 안에 남은 unverified가 없어야 한다.

password-strength fixture에서는 ac-3이 partial이고 unverified도 남아 있다. 그래서 `final_verdict`는 `partial`이다. 또한 다음에 이어받을 `next_handoff_path`가 있다.

이 파일은 "아직 끝나지 않았다"는 사실을 부끄러워하지 않는다. 오히려 그 사실을 명시한다. DITTO의 완료 계약은 실패를 숨기지 않기 위해 존재한다.

현재 구현에서는 `writeWorkItemHandoff()`가 이 파일을 만든다. schema는 잘못된 pass 주장을 reject한다.

완성된 DITTO에서는 Stop hook과 completion gate가 이 파일을 읽는다. 사용자가 보는 최종 응답도 이 파일의 verdict와 unverified를 거슬러 말하면 안 된다.

## 5. `handoff.md`: 다음 사람이 어디서 시작할까

JSON 파일들은 정확하지만 차갑다. 다음 사람이 바로 이어받기에는 `handoff.md`가 더 낫다.

fixture의 handoff는 끝난 일과 남은 일을 나눠 말한다. 비밀번호 정책 모듈, 400 응답, 테스트 일부는 끝났다. ac-3 메시지 분리와 기존 사용자 영향 회귀 테스트는 남았다.

그리고 어디서 이어받을지도 말한다. work item state, 마지막 run, 결정 기록이 어디 있는지 알려준다.

현재 구현에서 `ditto work handoff`는 이 파일을 생성한다. pass가 아닌 경우에는 다음 명령과 fresh evidence를 남긴다. pass일 때는 stale resume을 막기 위해 다음 명령을 남기지 않는다.

완성된 DITTO에서는 새 session 시작점이 될 가능성이 높다. context packet은 handoff를 요약해 provider에게 넘기고, workflow loop는 handoff 없이 partial로 끝나는 일을 막아야 한다.

## 6. `progress.md`: 중간에 무슨 일이 있었나

`progress.md`는 현재 상태보다는 시간의 흐름을 담는다.

`work-item.json`은 지금의 정답지에 가깝다. 반면 progress는 작업자가 지나온 길이다. 언제 무엇을 시도했고, 어느 지점에서 막혔는지가 들어갈 수 있다.

현재 구현은 이 파일을 직접 파싱하지 않는다. fixture 안에서는 사람이 읽는 보조 기록이다.

완성된 DITTO에서는 긴 작업의 timeline preview가 될 수 있다. 다만 context에 통째로 넣기보다는 최신 몇 줄이나 요약, path, hash로 다루는 편이 맞다.

## 7. `decisions.md`: 왜 그렇게 했나

`decisions.md`는 작은 결정의 보관함이다.

모든 결정을 ADR로 만들 수는 없다. 어떤 결정은 이 work item 안에서만 의미가 있다. 예를 들어 "기존 사용자 비밀번호 저장 경로는 건드리지 않는다" 같은 말은 다음 agent에게 매우 중요하지만, 프로젝트 전체 ADR까지 갈 필요는 없을 수 있다.

현재 구현은 이 파일을 schema로 검증하지 않는다. 하지만 handoff가 이 파일을 참조한다.

완성된 DITTO에서는 context packet의 "what not to touch"나 "known decisions"에 들어갈 재료가 된다. 큰 결정은 ADR로 승격하고, 작은 결정은 work item 안에 남긴다.

## 8. `result.md`: provider는 무엇을 했다고 생각했나

`runs/run_pwdcheck1/result.md`는 provider가 남긴 결과 요약이다.

이 파일은 증거 그 자체라기보다는 설명이다. provider가 어떤 의도로 바꿨고 무엇이 남았다고 봤는지를 알려준다.

현재 fixture에서는 acceptance evidence가 이 파일을 참조한다. 하지만 result.md만으로 완료를 주장할 수는 없다. command evidence와 diff가 함께 있어야 한다.

완성된 DITTO에서는 completion 초안, reviewer briefing, postmortem의 입력이 될 수 있다.

## 9. `stdout.log`, `stderr.log`: 날것의 출력

provider나 검증 명령이 남긴 raw output은 길고 지저분할 수 있다. 그래도 버리면 안 된다.

`stdout.log`와 `stderr.log`는 그 원본을 보존한다. manifest는 이 파일들의 path만 들고 있다.

현재 구현의 `ditto run with`도 stdout/stderr를 run 디렉터리에 저장한다.

완성된 DITTO에서는 evidence collector가 이 로그의 size, hash, preview를 관리해야 한다. context packet에는 전체 로그를 넣지 않고, 필요한 줄이나 요약만 넣어야 한다.

## 10. `diff.patch`: 무엇이 바뀌었나

`diff.patch`는 실행 결과로 생긴 코드 변경을 보존한다.

changed_files 목록은 "어떤 파일이 바뀌었다"까지만 말한다. diff는 "어떻게 바뀌었다"를 말한다.

현재 manifest는 `diff_path`로 이 파일을 가리킨다. `ditto run with`도 diff artifact를 남긴다.

완성된 DITTO에서는 reviewer lane이 이 diff를 주요 입력으로 삼는다. 큰 diff는 파일별 요약과 preview로 줄여야 하지만, 원본 artifact는 남아야 한다.

## 11. `reviews/rv_pwdcheck1.json`: 작성자 말고 누가 봤나

`reviews/rv_pwdcheck1.json`은 reviewer/evaluator의 결과다.

generator가 자기 작업을 스스로 pass라고 말하는 것은 충분하지 않다. 그래서 reviewer output은 별도 파일로 남는다. 여기에는 reviewer 종류, generator와 다른 provider인지, verdict, findings, unverified, recommended next action이 들어간다.

fixture에서는 cross-provider reviewer 결과를 보여준다. ac-3이 partial이라는 판단도 이 구조와 어울린다.

현재 구현은 이 파일을 자동 생성하지는 않는다. 다만 schema와 fixture test가 있다. `verdict=unverified`인데 evidence도 `review_not_run_reason`도 없으면 schema가 reject한다.

완성된 DITTO에서는 Phase 6 이후 evaluator lane이 이 파일을 만든다. completion gate는 reviewer output을 읽고, generator의 자기평가와 독립 판단이 충돌하는지 볼 수 있다.

## 12. `CONTEXT.md`와 `glossary.json`: 같은 말을 쓰기 위한 장치

작업 기록이 아무리 정확해도, 용어가 흔들리면 이어받기가 어려워진다.

`CONTEXT.md`는 사람이 읽는 용어 문서다. 프로젝트에서 "work item", "run", "evidence", "handoff" 같은 말을 어떻게 쓰는지 설명한다.

`glossary.json`은 같은 내용을 기계가 읽기 쉬운 형태로 둔 것이다. term, aliases, definition, forbidden abbreviations 같은 필드가 있다.

둘을 나눈 이유는 읽는 주체가 다르기 때문이다. 사람은 Markdown을 읽고, lint와 self-check는 JSON을 읽는다.

현재 구현은 `glossary.json`을 schema로 검증한다. `CONTEXT.md`와 의미가 같은지까지 비교하지는 않는다.

완성된 DITTO에서는 doctor나 lint가 두 파일의 drift를 잡아야 한다. Stop hook은 `glossary.json`을 보고 금지 약어, 미합의 용어, 애매한 표현을 막을 수 있다.

## 13. `language.md`와 `language-ledger.json`: 새 용어를 바로 굳히지 않기

작업 중에는 새 용어가 생긴다. 그런데 agent가 혼자 만든 용어를 곧바로 프로젝트 표준으로 넣으면 위험하다.

그래서 work item 안에 buffer를 둔다.

`language.md`는 사람이 읽는 용어 논의다. `language-ledger.json`은 그 논의를 기계가 읽을 수 있게 만든다. 어떤 term을 add/modify/deprecate/alias하려는지, 왜 필요한지, 누가 제안했는지, 사용자와 합의했는지가 들어간다.

현재 `WorkItemStore.create()`는 새 work item을 만들 때 빈 `language-ledger.json`을 같이 만든다. fixture test와 repo self-validation도 이 파일을 schema로 확인한다.

완성된 DITTO에서는 `agreed_with_user=false`인 용어를 사용자-facing 출력에서 조심해야 한다. 합의된 변경만 `CONTEXT.md`와 `glossary.json`으로 merge한다.

다만 여기에는 지금 기준으로 중요한 의문이 남아 있다.

현재 저장소의 실제 `language-ledger.json`들은 거의 모두 비어 있다. 파일은 만들어지고 schema 검증도 받지만, 아직 DITTO가 이 파일을 읽어 prompt를 바꾸거나, 사용자에게 확인을 요구하거나, glossary merge를 실행하지는 않는다. 그러므로 현재 실질 효과는 "나중에 용어 합의 흐름을 넣기 위한 자리 표시자"에 가깝다.

그렇다면 이 파일이 정말 work item 아래에 있는 것이 맞는가.

답은 "부분적으로만 맞다"에 가깝다. 새 용어가 생기는 순간은 보통 특정 work item 안이다. 예를 들어 사용자가 "이건 task가 아니라 work item이라고 부르자"라고 말하는 순간은 어떤 대화와 어떤 작업 안에서 발생한다. 그 제안의 출처, 이유, 합의 여부를 work item에 묶어 두는 것은 자연스럽다.

하지만 합의된 뒤의 용어는 더 이상 그 work item의 소유물이 아니다. 프로젝트 전체의 언어가 된다. 그 시점에는 `.ditto/knowledge/CONTEXT.md`와 `.ditto/knowledge/glossary.json`으로 올라가야 한다.

그래서 `language-ledger.json`의 적절한 역할은 "프로젝트 glossary 자체"가 아니라 "glossary로 올라가기 전의 변경 요청서"다. work item에 종속되는 것은 제안 단계까지는 타당하다. 하지만 merge 후에도 같은 정보가 work item 안에만 갇혀 있으면 잘못된 구조다.

완성된 DITTO에서 이 구조가 힘을 가지려면 적어도 세 가지 동작이 필요하다.

1. work item 도중 새 용어가 나오면 `language-ledger.json`에 `agreed_with_user=false`로 기록한다.
2. 사용자 합의가 생기면 같은 entry를 `agreed_with_user=true`로 바꾸고, `CONTEXT.md`와 `glossary.json`에 반영한다.
3. doctor나 self-check가 "ledger에는 합의된 변경이 있는데 glossary에는 없음", 또는 "ledger에는 미합의 용어인데 사용자 응답에서 표준 용어처럼 씀"을 잡아낸다.

이 세 가지가 없으면 `language-ledger.json`은 비용 대비 효과가 약하다. 모든 work item마다 빈 파일을 만드는 것도 noise가 될 수 있다. 실제 변경이 있을 때만 만드는 lazy file이 더 나을 수도 있다.

지금 문서에서 이 파일은 "필요한 계약 후보"로 읽어야 한다. 이미 강한 기능을 제공하는 파일은 아니다.

## Negative fixture는 보이지 않는 안전장치다

모든 fixture가 파일로 저장되어 있는 것은 아니다.

`tests/schemas/fixture-validation.test.ts` 안에는 일부러 잘못 만든 문서들이 있다. 이들은 negative fixture다.

예를 들어 이런 것들이다.

- `final_verdict=pass`인데 acceptance가 `fail`
- non-pass인데 `next_handoff_path`가 없음
- work item id prefix가 잘못됨
- repo 밖을 가리키는 `../` path
- reviewer output이 `unverified`인데 evidence도 미실행 사유도 없음
- `final_verdict=pass`인데 in-scope unverified가 남아 있음
- `partial`이나 `blocked`인데 `re_entry`가 없음
- command log entry에 필수 필드가 없음

이 테스트들은 "좋은 문서가 통과한다"보다 더 중요한 것을 확인한다.

나쁜 완료 주장이 실패하는가.

DITTO의 핵심은 여기에 있다. agent가 편한 말로 마무리하려고 해도, 파일 계약이 그 말을 받아주지 않아야 한다.

향후 self-check와 ask-user policy가 들어오면 negative fixture는 더 늘어야 한다. 불필요한 사용자 질문, 근거 없는 완료 주장, 미합의 용어 사용도 실패 사례로 고정해야 한다.

## 이 저장소의 `.ditto` 자체도 fixture다

`tests/fixtures/scenarios/password-strength`만 fixture가 아니다.

이 저장소의 `.ditto/`도 fixture다. DITTO는 자기 개발 작업을 자기 ledger로 남긴다. `wi_v01bootstrap`, `wi_v01implement`, `wi_v02doctor` 같은 디렉터리가 그래서 있다.

`tests/schemas/repo-self-validation.test.ts`는 이 실제 `.ditto`를 읽는다. work item, completion, language ledger, run manifest, command evidence가 schema를 통과하는지 본다.

이 방식은 약간 까다롭지만 유용하다. DITTO가 자기 기록을 읽지 못하면, 다른 프로젝트의 기록도 오래 버티기 어렵다.

완성된 DITTO에서는 새 clone이나 새 session이 committed `.ditto` subset만 보고도 작업 상태와 handoff를 재구성해야 한다.

다만 현재 sync policy는 아직 완성되지 않았다. 지금은 `.gitignore`가 `.ditto/runs/`와 `.ditto/work-items/*/evidence/`를 제외하는 수준이다. 어떤 파일을 팀 공유 대상으로 삼고, 어떤 파일을 로컬 artifact로 둘지는 ADR이 필요하다.

## 완성된 DITTO에서 이 fixture가 지나갈 길

완성된 DITTO를 상상하면, 하나의 작업은 이렇게 흐른다.

사용자가 요청한다.

DITTO는 `work-item.json`을 만든다. 아직 아무것도 검증하지 않았으므로 acceptance는 조심스럽게 시작한다.

계획 단계가 acceptance criteria와 risk를 다듬는다. 필요하면 `language-ledger.json`에 새 용어 제안을 남긴다.

provider를 실행하기 전에 context packet을 만든다. 이 packet은 work item, glossary, 이전 runs, handoff, evidence pointer를 모아 provider에게 전달된다.

`ditto run with`가 provider를 실행한다. stdout, stderr, diff가 artifact로 남고, manifest가 실행의 발자국을 기록한다.

검증 명령이 돌면 `commands.jsonl`에 evidence가 쌓인다. acceptance verdict는 이 evidence를 따라 움직인다.

reviewer/evaluator가 별도로 결과를 본다. 그 판단은 `reviews/<id>.json`에 남는다.

마감할 때 completion contract가 묻는다.

> 모든 acceptance가 pass인가?
> 아직 scope 안에 모르는 것이 남아 있나?
> 남았다면 다음 handoff가 있는가?

통과하면 work item은 `done`이 된다. 통과하지 못하면 `partial`이나 `unverified`로 남고, 다음 fresh evidence를 들고 다시 시작한다.

`password-strength` fixture는 이 흐름의 중간, 가장 현실적인 지점을 보여준다. 꽤 많이 했지만 아직 끝나지 않은 상태. DITTO가 정말 필요해지는 지점이다.

## 아직 덜 구현된 부분

Phase 0 요구가 모두 완성된 것은 아니다.

self-check contract는 아직 부분 구현이다. 지금은 completion contract의 cross-field rule과 handoff의 stale resume 제거가 일부 역할을 한다. 하지만 출력 lint, 추측 단정 차단, 약어 차단, 자기 답변 가능성 검사는 아직 별도 구현이 필요하다.

ask-user policy fixture도 아직 문서 수준이다. 불필요한 사용자 질문을 실패시키는 결정적 fixture가 필요하다.

`.ditto` commit/sync policy도 아직 정식 문서가 없다. `.gitignore`가 일부 방향을 보여줄 뿐이다.

`CONTEXT.md`와 `glossary.json`의 drift 검사도 없다. schema validation은 하지만, 두 파일이 같은 의미를 말하는지 비교하지 않는다.

reviewer/evaluator 자동 생성도 뒤 Phase의 일이다. 지금은 schema와 fixture가 먼저 놓여 있다.

이 미완 항목들은 실패가 아니라 Phase 0의 성격을 보여준다. Phase 0는 실행 loop를 완성하려던 단계가 아니었다. 나중 실행 loop가 거짓 완료를 말하지 못하도록 바닥을 깐 단계였다.

## Fixture를 바꿀 때 기억할 것

fixture를 바꿀 때는 파일 하나만 고치면 안 된다.

schema 필드 의미가 바뀌면 `src/schemas/*`, exported `schemas/*.schema.json`, golden fixture, repo self-validation fixture가 같이 움직여야 한다.

성공 사례만 남기면 안 된다. partial, unverified, blocked, invalid 사례가 있어야 DITTO의 안전장치가 살아 있다.

큰 로그나 diff를 manifest에 직접 넣지 않는다. path, hash, preview로 연결한다.

`final_verdict=pass`에는 in-scope unverified를 남기지 않는다.

non-pass에는 `next_handoff_path`와 재진입 정보가 있어야 한다.

그리고 가장 중요한 기준은 이것이다.

대화 기록 없이 fixture만 읽은 사람이 다음 행동을 설명할 수 있어야 한다.

그게 되면 fixture는 문서 이상의 역할을 한다. 다음 agent가 길을 잃지 않게 하는 작은 지도 역할을 한다.
