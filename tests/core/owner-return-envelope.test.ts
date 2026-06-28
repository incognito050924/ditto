import { describe, expect, test } from 'bun:test';
import {
  guardEnvelopeArtifact,
  guardEnvelopeOwnerMatch,
  guardOwnerEnvelope,
} from '~/core/autopilot-dispatch';
import { recordResultPayload } from '~/core/autopilot-loop';
import { ownerReturnEnvelope } from '~/schemas/owner-return-envelope';

// A conforming implementer envelope used as the base for round-trip / mutation.
const conforming = {
  summary: 'Added the owner-return envelope schema and guard',
  verbatim_detail: 'wrote src/schemas/owner-return-envelope.ts; ran bun test → 2900 pass',
  conclusion: 'envelope formalizes the human return; machine slots stay distinct',
  evidence: [{ kind: 'command', command: 'bun test', summary: '2900 pass / 0 fail' }],
  uncertainty: [{ item: 'ac-2 read-path', reason: 'partly a contract, not pure code' }],
  verdict: 'pass',
  owner_kind: 'implementer',
} as const;

describe('guardOwnerEnvelope (ac-1: rejects non-conforming WITHOUT throwing)', () => {
  test('malformed envelope returns a structured fixable reject, never throws', () => {
    // missing required slots (summary/conclusion/verdict/owner_kind)
    const malformed = { verbatim_detail: 'detail only' };
    let result: ReturnType<typeof guardOwnerEnvelope> | undefined;
    expect(() => {
      result = guardOwnerEnvelope(malformed);
    }).not.toThrow();
    expect(result).toMatchObject({ contentful: false, failure_class: 'fixable' });
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  test('a conforming envelope passes the shape guard', () => {
    expect(guardOwnerEnvelope(conforming).contentful).toBe(true);
  });

  test('a non-retrospective summary-only envelope (no verbatim, no pointer) is rejected', () => {
    const bare = {
      summary: 'just a summary',
      conclusion: 'done',
      verdict: 'pass',
      owner_kind: 'implementer',
    };
    expect(guardOwnerEnvelope(bare)).toMatchObject({ contentful: false, failure_class: 'fixable' });
  });
});

describe('guardEnvelopeOwnerMatch (wi_2606274be: owner_kind cannot be self-relabeled to dodge the exemption)', () => {
  test('owner_kind matching the dispatched node owner passes', () => {
    expect(guardEnvelopeOwnerMatch(conforming, 'implementer').contentful).toBe(true);
  });

  test('owner_kind that disagrees with the dispatched node owner is a fixable reject', () => {
    const relabeled = { ...conforming, owner_kind: 'retrospective' } as const;
    expect(guardEnvelopeOwnerMatch(relabeled, 'implementer')).toMatchObject({
      contentful: false,
      failure_class: 'fixable',
    });
  });

  test('REGRESSION: a bare retrospective-labeled envelope (passes the exemption) is still caught when the node owner is not retrospective', () => {
    // This bare envelope clears guardOwnerEnvelope because owner_kind=retrospective
    // is exempt from the verbatim_detail reachability rule (superRefine). The
    // owner-match guard is what stops an implementer from claiming that exemption.
    const bareRetro = {
      summary: 'just a summary, no detail',
      conclusion: 'done',
      verdict: 'pass',
      owner_kind: 'retrospective',
    } as const;
    expect(guardOwnerEnvelope(bareRetro).contentful).toBe(true);
    expect(guardEnvelopeOwnerMatch(bareRetro, 'implementer')).toMatchObject({
      contentful: false,
      failure_class: 'fixable',
    });
  });

  test('a genuine retrospective node with a retrospective envelope still passes', () => {
    const retro = {
      summary: 'retro metrics',
      conclusion: 'two separate metrics presented',
      verdict: 'pass',
      owner_kind: 'retrospective',
    } as const;
    expect(guardEnvelopeOwnerMatch(retro, 'retrospective').contentful).toBe(true);
  });
});

describe('ownerReturnEnvelope schema (ac-2/ac-4 slot policy)', () => {
  test('oversized verbatim_detail PASSES (no size-cap — lossless preservation)', () => {
    const huge = { ...conforming, verbatim_detail: 'x'.repeat(500_000) };
    const parsed = ownerReturnEnvelope.safeParse(huge);
    expect(parsed.success).toBe(true);
  });

  test('retrospective legit-empty (no verbatim, no pointer) passes; non-retrospective bare is rejected', () => {
    const retro = {
      summary: 'two metrics',
      conclusion: 'measured',
      verdict: 'pass',
      owner_kind: 'retrospective',
    };
    expect(ownerReturnEnvelope.safeParse(retro).success).toBe(true);

    const bareImpl = { ...retro, owner_kind: 'implementer' };
    expect(ownerReturnEnvelope.safeParse(bareImpl).success).toBe(false);
  });

  test('artifact_location is an accepted alternative to inline verbatim_detail', () => {
    const viaPointer = {
      summary: 'findings index',
      artifact_location: 'reports/findings.md',
      conclusion: 'see artifact',
      verdict: 'pass',
      owner_kind: 'researcher',
    };
    expect(ownerReturnEnvelope.safeParse(viaPointer).success).toBe(true);
  });

  test('summary is distinct from verbatim_detail and machine slots survive a parse', () => {
    const parsed = ownerReturnEnvelope.parse(conforming);
    expect(parsed.summary).toBe(conforming.summary);
    expect(parsed.verbatim_detail).toBe(conforming.verbatim_detail);
    expect(parsed.summary).not.toBe(parsed.verbatim_detail);
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.verdict).toBe('pass');
  });
});

describe('recordResultPayload envelope field (additive optional, backward compat)', () => {
  test('a conforming envelope round-trips with evidence_refs/ac_verdicts/changed_files distinct', () => {
    const payload = {
      node_id: 'impl-1',
      result_text: 'built the envelope schema and guards',
      outcome: 'pass',
      evidence_refs: [{ kind: 'command', command: 'bun test', summary: 'green' }],
      ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      changed_files: ['src/schemas/owner-return-envelope.ts'],
      envelope: conforming,
    };
    const parsed = recordResultPayload.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The structured machine slots stay distinct from the envelope.
      expect(parsed.data.evidence_refs).toHaveLength(1);
      expect(parsed.data.ac_verdicts?.[0]?.criterion_id).toBe('ac-1');
      expect(parsed.data.changed_files).toEqual(['src/schemas/owner-return-envelope.ts']);
      expect(parsed.data.envelope?.summary).toBe(conforming.summary);
      expect(parsed.data.envelope?.verbatim_detail).toBe(conforming.verbatim_detail);
    }
  });

  test('a legacy payload with NO envelope field still parses (backward compat)', () => {
    const legacy = {
      node_id: 'verify-1',
      result_text: 'verified the criterion',
      outcome: 'pass',
      evidence_refs: [{ kind: 'note', summary: 'ok' }],
    };
    const parsed = recordResultPayload.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.envelope).toBeUndefined();
  });
});

describe('guardEnvelopeArtifact (ac-1: artifact pointer must resolve to non-empty; never throws)', () => {
  const withPointer = ownerReturnEnvelope.parse({
    summary: 'findings index',
    artifact_location: 'reports/findings.md',
    conclusion: 'see artifact',
    verdict: 'pass',
    owner_kind: 'researcher',
  });
  const noPointer = ownerReturnEnvelope.parse(conforming);

  test('present pointer to a non-empty artifact passes', async () => {
    const guard = await guardEnvelopeArtifact(withPointer, async () => 'real findings content');
    expect(guard.contentful).toBe(true);
  });

  test('present pointer to an EMPTY artifact is rejected (no throw)', async () => {
    let guard: Awaited<ReturnType<typeof guardEnvelopeArtifact>> | undefined;
    await expect(
      (async () => {
        guard = await guardEnvelopeArtifact(withPointer, async () => '   \n  ');
      })(),
    ).resolves.toBeUndefined();
    expect(guard).toMatchObject({ contentful: false, failure_class: 'fixable' });
  });

  test('unresolvable pointer (read throws) is caught and returned, never propagated', async () => {
    let guard: Awaited<ReturnType<typeof guardEnvelopeArtifact>> | undefined;
    await expect(
      (async () => {
        guard = await guardEnvelopeArtifact(withPointer, async () => {
          throw new Error('ENOENT');
        });
      })(),
    ).resolves.toBeUndefined();
    expect(guard).toMatchObject({ contentful: false, failure_class: 'fixable' });
  });

  test('no artifact_location ⇒ no-op pass (the read is never attempted)', async () => {
    let read = false;
    const guard = await guardEnvelopeArtifact(noPointer, async () => {
      read = true;
      return 'x';
    });
    expect(guard.contentful).toBe(true);
    expect(read).toBe(false);
  });
});
