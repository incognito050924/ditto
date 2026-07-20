/**
 * Live CLI integration smoke (#63) — NOT a unit test. Proves the LiveHost seam
 * actually drives the real `claude` CLI: runDrive returns a schema-valid
 * boundary + session id, runFanout returns free text per task. Makes real
 * nested `claude` calls (cost + time), so it is a script run on demand
 * (`bun rebuild/seam/live-smoke.ts`), never part of `bun test rebuild/`.
 */
import { boundaryEnvelope } from './host-adapter';
import { LiveHost, liveHostDeps } from './live-host';

async function main(): Promise<void> {
  const host = new LiveHost(liveHostDeps);

  // runDrive → schema-forced structured boundary (the queue oracle).
  const drive = await host.driveStep({
    prompt:
      'Return a disposition boundary. The queue field MUST be an empty array [] and omit the gate field.',
  });
  const boundaryOk = boundaryEnvelope.safeParse(drive.boundary).success;
  const sessionOk = drive.sessionId.length > 0;
  console.log('[runDrive] sessionId:', drive.sessionId);
  console.log('[runDrive] boundary:', JSON.stringify(drive.boundary));
  console.log(
    `[runDrive] boundary-schema-valid=${boundaryOk} sessionId-non-empty=${sessionOk}`,
  );

  // runFanout → one isolated call per task, free text back.
  const texts = await host.fanout([
    { agentType: 'general', prompt: 'Reply with exactly one word: alpha' },
    { agentType: 'general', prompt: 'Reply with exactly one word: beta' },
  ]);
  const fanoutOk = texts.length === 2 && texts.every((t) => t.length > 0);
  console.log('[runFanout] count:', texts.length, 'texts:', JSON.stringify(texts));
  console.log(`[runFanout] two-nonempty-texts=${fanoutOk}`);

  const pass = boundaryOk && sessionOk && fanoutOk;
  console.log(`SMOKE ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error('SMOKE ERROR', err);
  process.exit(1);
});
