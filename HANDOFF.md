# HANDOFF — 메모리 리뷰 후속 8건 수정 검증 (2026-06-10)

새 세션 **독립 검증**용. 작성자(이전 세션)의 자기평가를 믿지 말고 fresh evidence로 재검증하라. 이어받은 뒤 갱신/삭제해도 됨.

## ⚠ 먼저 — 상태 제약 (검증 가능 여부를 가름)

- **8건 코드/문서 변경은 아직 커밋 안 됨.** HEAD는 `2a408b1`(직전 핸드오프)이고, 수정은 작업 트리에만 있다.
  - **같은 PC 새 세션**: 작업 트리에 그대로 있으니 바로 검증 가능(git pull 불필요).
  - **다른 PC**: 이 변경과 이 핸드오프는 **커밋·푸시해야** 간다. 안 하면 새 PC엔 코드가 없어 검증 불가. (커밋은 이전 세션이 사용자 지시 대기 중이었음 — 다른 PC 검증이면 먼저 커밋·푸시할 것.)
- **`.ditto/local/`은 git으로 안 간다.** work item `wi_2606104bd`의 autopilot.json·intent.json·completion.json·evidence는 **이 PC에만** 있다. 새 PC에선 없다(검증은 코드·테스트로 자기완결하게 아래에 적었다).
- **bun은 1.3.14 이상**이어야 한다. 1.0.2는 `FileHandle.close` 미구현으로 메모리 테스트가 가짜 실패한다.

## 무엇을 검증하나

`reports/reviews/memory-subsystem-review.md`(이전 세션이 쓴 `ditto memory` 종합 리뷰)의 발견 8건을 ditto autopilot 자율주행(work item `wi_2606104bd`, 7노드)으로 수정했다. final_verdict=pass(9/9 AC)로 닫았다고 주장한다 — 이걸 독립 검증하는 게 이 세션의 일이다.

### 변경 파일 (전부 미커밋, `git status`로 확인)
코드: `src/core/memory-{bootstrap,project,build,query,scan}.ts`, `src/cli/commands/memory.ts`, `src/hooks/pre-tool-use.ts`
문서: `.ditto/knowledge/adr/ADR-0013-memory-subsystem-design.md`, `reports/design/memory-graph-plugin-design.md`
테스트: `tests/core/memory-{bootstrap,project,build,query}.test.ts`, `tests/cli/memory-cli.test.ts`, `tests/hooks/pre-tool-use.test.ts`

### 8건 수정 내역과 검증 포인트

| # | 무엇을 고쳤나 | 어떻게 검증 (fresh) |
|---|---|---|
| **F1** | bootstrap이 ingest한 glossary/handoff를 `approved`로 승격 + projection이 approved observation을 `Episode` 노드, source를 `Source` 노드로 노출 | 격리repo 재현(아래 ①). 리뷰 전엔 `Decision` 1개뿐이었다 → 이제 Episode·Source가 보여야 |
| **F2** | `searchEventBodies`를 query 런타임에 배선(`queryBodies` + CLI `--text`/node-not-found fallback) | `bun test tests/core/memory-query.test.ts`. 격리repo에서 제목에 없고 본문에만 있는 토큰으로 `ditto memory query <token> --text`가 결과 반환 |
| **F3** | `approveEvent`에 `approverKind` 추가 — `actor.kind=agent`로 제안된 이벤트는 user만 승인 | 격리repo: `propose --actor agent` 후 `approve --actor agent` → **거부(exit 65)**, `--actor user` → 통과(exit 0) |
| **F4** | RATIONALE_FOR 엣지의 `source:` 노드를 실제 그래프 노드로 생성(dangling 해소) | 격리repo: `ditto memory query source:<id>`가 이웃 반환(이전엔 NotFound) |
| **F5** | ADR-0013/설계서에 knowledge↔memory drift 한계·재ingest 정책 명시 | `git diff`로 ADR-0013·설계서에 "knowledge↔memory"/"재ingest" 문구 확인. `bun test tests/core/memory-bootstrap.test.ts` |
| **F6** | `sensitivity=secret` source/event를 projection·build chunk에서 제외 | `bun test tests/core/memory-build.test.ts tests/core/memory-project.test.ts` |
| **F7** | `approve <eventId>`를 `memoryEventId` 스키마로 검증 | 격리repo: `ditto memory approve "../../../etc/hosts" --by x` → **거부(exit 65)** |
| **hook** | PreToolUse scope-out이 `~/.claude/projects/*/memory/` 쓰기를 허용(repo밖 그외·secret은 차단 유지) | `bun test tests/hooks/pre-tool-use.test.ts`. **단 동작 hook은 컴파일된 `bin/ditto`라 소스만 고쳐선 런타임 미반영** — 실동작 검증하려면 `bun run build:bin` 후. 안 하면 단위테스트(163 pass)로만 |

## 독립 검증 절차

```bash
# (다른 PC면 먼저: git pull && bun install && bun run build:bin && bun run build && bun link)
bun --version            # 1.3.x 이상 확인
bun test 2>&1 | tail -5  # 기대: 1555 pass / 1 fail. 그 1 fail은 아래 '환경 함정'의 wi_v01bootstrap(무관)
bunx biome check src/core/memory-*.ts src/cli/commands/memory.ts src/hooks/pre-tool-use.ts
```

### ① 격리repo 재현 (F1/F2/F3/F4/F7 — 핵심, 리뷰 주장의 산 증거)
```bash
TMP=$(mktemp -d); cd "$TMP"; git init -q; git config user.email t@t.co; git config user.name t
mkdir -p .ditto/knowledge/adr .ditto/local/handoff/archive
printf '{ "entries": [ {"term":"wave splitting","definition":"autopilot partitions ready nodes ... frobnicate"} ] }' > .ditto/knowledge/glossary.json
printf '# ADR-0001\n\n## 결정\nmutating 1 cap.\n\n## 근거\n파일 겹침 방지 drift.\n' > .ditto/knowledge/adr/ADR-0001-x.md
printf -- '---\n{ "original_intent": "fix wave clobber" }\n---\n# h\n' > .ditto/local/handoff/archive/wi_old__x.md
ditto memory bootstrap --output json && ditto memory project --output json
# F1/F4: graph.json node_type 분포에 Episode·Source 가 있어야 (리뷰 전엔 Decision 1뿐)
python3 -c "import json,collections; g=json.load(open('.ditto/local/memory/projections/graph.json')); print(collections.Counter(n['node_type'] for n in g['nodes']))"
# F2: 본문에만 있는 토큰
ditto memory query frobnicate --text
# F3: self-approve 거부
ID=$(ditto memory propose --type analysis --text guess --confidence INFERRED --actor agent --output json | python3 -c "import json,sys;print(json.load(sys.stdin)['event_id'])")
ditto memory approve "$ID" --by a --actor agent   # exit 65 기대
ditto memory approve "$ID" --by human --actor user # exit 0 기대
# F7: traversal id 거부
ditto memory approve "../../../etc/hosts" --by x    # exit 65 기대
cd - && rm -rf "$TMP"
```

## 의심해야 할 지점 (검증자가 따져볼 것)

이전 세션이 내린 **구현 결정**들 — 동작은 맞지만 설계적으로 이게 옳은지 검증자가 판단:
1. **F3 정책이 kind 기반**: actor에 식별자가 없어 "agent가 제안 → user만 승인"으로 강제했다. 즉 *다른* agent도 승인 못 한다(제안자≠승인자보다 엄격). 자율주행 중 메모리 승인이 필요하면 사람 개입이 강제됨 — 이게 의도대로인가. (현재 autopilot은 memory approve를 호출하지 않아 실질 영향은 없음.)
2. **F1이 bootstrap을 approved 승격**: pending은 그래프에 안 보인다는 §4-5 승인모델과의 화해를 "bootstrap=이미 큐레이션된 자산"으로 정당화했다. `propose` 경로는 여전히 pending. ADR이 원래 approved였던 것과 일관 — 그래도 "사람 승인 없이 approved"가 맞는지.
3. **F2가 query 동작을 바꿈**: node-not-found가 이전엔 usage 에러(exit 65)였는데 이제 본문검색 fallback(exit 0). 이 동작 변경이 외부 스크립트에 영향 없는지.
4. **hook 허용 범위**: `~/.claude/projects/*/memory/`만 좁게 뚫었다. secret은 여전히 우선 차단. 범위가 적절한지.
5. **autopilot completion 우회**: gotcha 3(worst-fold)가 발동해, `wi_2606104bd/autopilot.json`에서 implement 노드(N1~N6)의 `acceptance_refs`를 비우고 verifier(N7)에 `evidence_refs`를 수동 주입해 final_verdict=pass를 얻었다. **이건 엔진 결함 우회지 거짓 통과가 아님**(N7이 실제 fresh evidence로 9 AC 검증) — 그러나 completion 산출물(`.ditto/local`, 이 PC에만)을 신뢰하지 말고 위 ①로 직접 재현해 판정하라.

## 환경 함정 (이 작업 무관, 검증 중 마주침)
- **`bun test`의 남은 1 fail = `repo-self-validation > wi_v01bootstrap and wi_v01implement exist`**: 이 PC의 `.ditto/local/work-items/`에 과거 work item이 있길 기대하는 테스트라 fresh PC/다른 상태에선 항상 실패한다. 로컬 상태에 결합된 **테스트 설계 결함**(리뷰의 별도 항목), 8건 수정과 무관. 이것만 fail이면 정상.
- `.ditto/local/surfaces.json`은 생성형 — pull 후 drift 테스트 실패 시 `bun run surfaces:gen`.
- `bunx tsc --noEmit`엔 사전존재 214건(`src/acg/*` 등)이 있다. 검증 기준은 "메모리/hook 파일발 신규 에러 0"이다(`| grep -E 'memory-|pre-tool-use|commands/memory'`로 0 확인).

## 검증 후
- 8건이 모두 재현되면 → 커밋(동작적 변경, 한 논리 단위). 미커밋 상태이므로 검증자가 커밋·푸시하면 다른 PC로도 전파된다.
- 실패를 발견하면 재현 절차와 함께 기록(어느 F, 어느 명령, 기대 vs 실제).
