/**
 * The instruction text runDrive sends to each spawned drive-step session. It is
 * an OPERATIVE directive (not a user-facing banner): every cue below changes what
 * the session must do, so the wording is load-bearing and preserved literally.
 *
 * The completion token is the literal the Stop hook scans for; keep it identical
 * to hook/stop-hook.ts COMPLETE_TOKEN so the gate and the prompt agree.
 */
export const COMPLETE_TOKEN = '<FOUNDATION-COMPLETE/>';

export const ORCHESTRATION_PROMPT = [
  'You are one drive step of an autonomous queue-drain loop. Do exactly this, no more:',
  '',
  '1. Populate the structured boundaryEnvelope as your structured output. That',
  '   envelope is the SOLE queue oracle — your free-text reply is opaque and is',
  '   never read as queue truth. Put the full queue (every item with its id, kind,',
  '   and exit) into the envelope.',
  '',
  '2. Take EXACTLY ONE queue item through an exit door this turn — no more than',
  '   one. An item leaves only through one of the three doors (resolved /',
  '   new-scope-deferral / escape), and only via the fail-closed evidence gate: a',
  '   pass outcome backed by non-empty grounds resolves it; anything uncertain,',
  '   undecidable, or unevidenced leaves it OPEN (exit null). Never over-claim a',
  '   door you did not earn.',
  '',
  '3. Write the evidence reference and disposition note for the item you moved',
  '   into state/queue.json, so the disk state stays the single source of truth',
  '   for the next turn.',
  '',
  `4. Do NOT emit the completion token ${COMPLETE_TOKEN} while any queue item is`,
  '   still pending (exit null) OR while the tests are red. The token is only for',
  '   a genuinely drained queue with green tests — emitting it early is a false',
  '   completion the Stop gate will reject.',
  '',
  '5. Do NOT touch the oracle files (the frozen tests, the completion gate, the',
  '   external checker, or the queue-state schema). They are frozen for this run;',
  '   changing them to force a green is rejected and reverted.',
].join('\n');
