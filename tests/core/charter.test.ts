import { describe, expect, test } from 'bun:test';
import { type CharterContext, charterProjection } from '~/core/charter';
import { OPAQUE_VOCAB_FLOOR, findUnexplainedIdentifiers } from '~/core/question-context';

describe('charterProjection (D8)', () => {
  test('base case: prime directive only when ctx is empty', () => {
    const out = charterProjection();
    expect(out).toContain('기본 지침'); // reworded to plain Korean (wi_260713nlg); 'prime directive' kept as anchor
    expect(out).not.toContain('▶');
    expect(out).not.toContain('⚠');
  });

  test('placeholderAcceptanceCriteria → placeholder advisory (⚠)', () => {
    const out = charterProjection({ placeholderAcceptanceCriteria: true });
    expect(out).toContain('acceptance criteria가 아직 자리표시자다');
    expect(out).toContain('/ditto:deep-interview');
  });

  test('deepInterviewDirective → concrete /ditto:deep-interview directive (▶)', () => {
    const out = charterProjection({ deepInterviewDirective: true });
    expect(out).toContain('지금 /ditto:deep-interview를 실행하라');
    expect(out).toContain('권장');
    expect(out).toContain('가벼운 경로'); // light-path fallback still surfaced (internal name anchor dropped, wi_260713nlg iter)
  });

  test('base prime directive reflects the agent-judged, agent-registered work-item model', () => {
    const out = charterProjection();
    // The hook does not auto-create on every prompt; the agent decides (plain-Korean
    // reword wi_260713nlg — the operative cues survive with equal force/polarity).
    expect(out).toContain('훅은 절대 자동으로 만들지 않는다');
    expect(out).toContain('네가 판단한다'); // "YOU judge"
    // Creation is agent-driven (the agent runs the command), not user-manual.
    expect(out).toContain('네가 직접 등록한다'); // "register it YOURSELF"
    expect(out).toContain('ditto work start');
  });

  test('workItemGuide → empty-state work-item guide advisory (⚠)', () => {
    const out = charterProjection({ workItemGuide: true });
    expect(out).toContain('활성 work item이 없다'); // "No active work item"
    expect(out).toContain('1차 판단'); // "1st-pass judgment"
    expect(out).toContain('ditto work start');
  });

  // idea ② (wi_260627v93): weight-routing guidance — small/reversible → light path,
  // heavy reserved for ambiguous/irreversible/multi-surface. Advisory (agent-judged,
  // NOT an auto-classifier/auto-router) per D4 ADR (ADR-20260627). Always projected.
  test('prime directive carries weight-routing guidance (small/reversible → light)', () => {
    const out = charterProjection();
    expect(out).toContain('무게로 라우팅'); // "Route by weight"
    expect(out).toContain('작고 되돌릴 수 있으면 → 가벼운 경로'); // small/reversible → light
    expect(out).toContain('ditto work set-criteria'); // light path entry command
    expect(out).toContain('/ditto:deep-interview'); // heavy path entry
    expect(out).toContain('권고'); // "advisory"
    expect(out).toContain('네가 판단한다'); // "you judge"
    expect(out).toContain('위험이 선언되면 → 무거운 경로'); // declared risk defaults heavy
  });

  // wi_2606290xm: only two standard paths exist; the ad-hoc/console-TDD third
  // path is forbidden. The *choice* between the two stays advisory (above), but
  // *bypassing* both is hard-forbidden — this is the always-projected guard.
  test('prime directive forbids the ad-hoc third path (only two standard paths)', () => {
    const out = charterProjection();
    expect(out).toContain('딱 두 갈래 표준 경로로만'); // "TWO standard paths only"
    expect(out).toContain('work item 없이 즉흥적으로 코드를 고치는 것'); // ad-hoc/console-TDD outside a work item
    expect(out).toContain('허용되지 않는다'); // hard prohibition preserved (self-explanatory, wi_260713nlg iter)
    expect(out).toContain('TDD는 경로 안에서 구현하는 방법'); // "TDD is HOW you implement inside a path"
    // The path *choice* must remain agent-judged (no regression on routing tone).
    expect(out).toContain('무게로 라우팅'); // "Route by weight"
    expect(out).toContain('네가 판단한다'); // "you judge"
  });

  test('selfAnswerHint → QuestionGate advisory (⚠)', () => {
    const out = charterProjection({ selfAnswerHint: true });
    expect(out).toContain('코드·문서·웹에서 먼저 스스로 답하라'); // self-answer from code/docs/web first
    expect(out).toContain('사용자 입력 없이도 답할 수 있어'); // self-answer cue (internal name anchor dropped, wi_260713nlg iter)
  });

  test('all advisory flags can stack independently', () => {
    const ctx: CharterContext = {
      placeholderAcceptanceCriteria: true,
      deepInterviewDirective: true,
      selfAnswerHint: true,
    };
    const out = charterProjection(ctx);
    expect(out).toContain('acceptance criteria가 아직 자리표시자다');
    expect(out).toContain('지금 /ditto:deep-interview를 실행하라');
    expect(out).toContain('코드·문서·웹에서 먼저 스스로 답하라');
  });

  test('work item header + handoff hint still render with new fields', () => {
    const out = charterProjection({
      workItemId: 'wi_test1234',
      workItemTitle: 'sample',
      workItemStatus: 'draft',
      pendingHandoff: '.ditto/work-items/wi_test1234/handoff.json',
      deepInterviewDirective: true,
    });
    expect(out).toContain('Active work item: wi_test1234');
    expect(out).toContain('title="sample"');
    expect(out).toContain('Pending handoff/re-entry:');
    expect(out).toContain('지금 /ditto:deep-interview를 실행하라');
  });

  // ── wi_260713nlg: plain-Korean reword — directive-fidelity + readability gate ──
  // These banners are runtime LLM instruction injected EVERY turn (not display
  // copy). The reword must keep every operative cue with equal force and polarity.
  describe('plain-Korean reword (wi_260713nlg)', () => {
    // Check #2: the reworded banners leak NO un-glossed internal identifier
    // (ac-{n}/T-{n}/D{n}/wi_…/orch_… shapes). Uses the read-only detector.
    test('unexplained-abbreviation count == 0 across all banner surfaces', () => {
      const surfaces = [
        charterProjection(),
        charterProjection({
          workItemGuide: true,
          placeholderAcceptanceCriteria: true,
          deepInterviewDirective: true,
          selfAnswerHint: true,
        }),
      ];
      for (const s of surfaces) {
        expect(findUnexplainedIdentifiers(s)).toEqual([]);
      }
    });

    // wi_260714aaq (#29) ac-3: the new opaque-vocab class is HARD on the deep-interview
    // QUESTION face but ADVISORY at the per-turn banner (#30 has not rewritten these strings
    // yet). Concretely, no OPAQUE_VOCAB_FLOOR entry raw-leaks into any banner surface — the
    // banner uses the SPACE form ("acceptance criteria") while the floor uses the UNDERSCORE
    // form ("acceptance_criteria"), and no axis name / coined compound appears — so the banner
    // is never hard-blocked by the new class. Regression guard: a future banner edit that
    // surfaces an axis name / schema field un-glossed trips here.
    test('no OPAQUE_VOCAB_FLOOR entry raw-leaks into any banner surface (ac-3: banner advisory)', () => {
      const surfaces = [
        charterProjection(),
        charterProjection({
          workItemGuide: true,
          placeholderAcceptanceCriteria: true,
          deepInterviewDirective: true,
          selfAnswerHint: true,
        }),
      ];
      for (const s of surfaces) {
        for (const entry of OPAQUE_VOCAB_FLOOR) {
          expect(s).not.toContain(entry);
        }
      }
    });

    // Check #3: directive-fidelity — every enumerated operative cue (imperative,
    // prohibition, routing threshold, completion gate) is present in the reworded
    // PRIME_DIRECTIVE, each with its polarity intact.
    test('PRIME_DIRECTIVE keeps every operative cue', () => {
      const out = charterProjection();
      const cues = [
        'prime directive', // canonical name anchor
        '원래 요청을 그대로 지킨다', // preserve original request (internal name dropped, wi_260713nlg iter)
        '범위를 넓히지도, 줄이거나 쪼개지도 않는다', // no grow, no shrink/split
        '사용자 승인 없이', // without user approval
        '딱 두 갈래 표준 경로로만', // TWO standard paths only
        '/ditto:deep-interview', // heavy path entry
        'autopilot',
        'ditto work set-criteria', // light path
        'ditto verify',
        'ditto work done',
        'work item 없이 즉흥적으로 코드를 고치는 것(콘솔에서 바로 TDD로 편집)은 허용되지 않는다', // FORBIDDEN ad-hoc editing (self-explanatory prohibition, wi_260713nlg iter)
        'TDD는 경로 안에서 구현하는 방법', // TDD is HOW, not a substitute
        '네가 판단한다', // YOU judge
        '무게로 라우팅', // Route by weight
        '권고', // advisory
        '작고 되돌릴 수 있으면 → 가벼운 경로', // small/reversible → light
        '위험이 선언되면 → 무거운 경로', // declared risk → heavy
        '훅은 절대 자동으로 만들지 않는다', // hook never auto-creates
        '네가 직접 등록한다', // register it YOURSELF
        'ditto work start',
        '사용자만 답할 수 있는 것만 묻는다', // ask only what only the user can answer (internal name dropped, wi_260713nlg iter)
        '코드·문서·웹에서 스스로 답한다', // self-answer the rest
        '완료(통과)로 판정하기 전에', // completion gate (plainified; internal field name dropped, wi_260713nlg iter)
        '모든 acceptance criterion을 증거와 함께 닫는다', // evidence-gated completion
        'work item 전체이지 중간 체크포인트가 아니다', // whole work item is the bar
        '스스로 점검(minimal-increment)', // self-check projected verbatim
      ];
      for (const cue of cues) expect(out).toContain(cue);
    });

    // Check #1: snapshot-fix — pin the reworded advisory strings so a future edit
    // that silently drops/softens a cue trips the test.
    test('reworded advisory strings are pinned', () => {
      expect(charterProjection({ workItemGuide: true })).toContain(
        '활성 work item이 없다. 1차 판단을 네가 직접 한다',
      );
      expect(charterProjection({ placeholderAcceptanceCriteria: true })).toContain(
        'acceptance criteria가 아직 자리표시자다 — 행동하기 전에 /ditto:deep-interview로 구체화하라',
      );
      expect(charterProjection({ deepInterviewDirective: true })).toContain(
        '지금 /ditto:deep-interview를 실행하라 — acceptance criteria가 아직 자리표시자이고 실행 의도가 감지됐다',
      );
      expect(charterProjection({ selfAnswerHint: true })).toContain(
        '묻기 전에 코드·문서·웹에서 먼저 스스로 답하라',
      );
    });
  });
});
