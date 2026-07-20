import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { DriveStepInput, FanoutTask } from './host-adapter';
import { LiveHost, type HostDeps } from './live-host';

// A default fake HostDeps; each test overrides only the method it exercises.
const fakeDeps = (over: Partial<HostDeps>): HostDeps => ({
  runDrive: () => ({ sessionId: 's', boundaryJson: '{"queue":[]}' }),
  runFanout: () => [],
  readFile: () => '{}',
  ...over,
});

describe('LiveHost', () => {
  test('driveStep parses the structured boundary as the queue oracle', async () => {
    const host = new LiveHost(
      fakeDeps({
        runDrive: () => ({
          sessionId: 's1',
          boundaryJson: JSON.stringify({
            queue: [{ id: 'a', kind: 'in-scope-residual' }],
          }),
        }),
      }),
    );

    const out = await host.driveStep({ prompt: 'p' });

    expect(out.sessionId).toBe('s1');
    expect(out.boundary.queue[0]?.id).toBe('a');
  });

  test('driveStep is fail-closed: invalid boundary JSON rejects', async () => {
    const host = new LiveHost(
      fakeDeps({
        runDrive: () => ({
          sessionId: 's1',
          boundaryJson: '{"queue":[{"bogus":1}]}',
        }),
      }),
    );

    await expect(host.driveStep({ prompt: 'p' })).rejects.toThrow();
  });

  test('driveStep passes resume through to the deps', async () => {
    let seen: DriveStepInput | undefined;
    const host = new LiveHost(
      fakeDeps({
        runDrive: (input) => {
          seen = input;
          return { sessionId: 'x', boundaryJson: '{"queue":[]}' };
        },
      }),
    );

    await host.driveStep({ prompt: 'p', resume: 'sess-9' });

    expect(seen?.resume).toBe('sess-9');
  });

  test('stopGate delegates to decideGate (fail-closed)', () => {
    const host = new LiveHost(fakeDeps({}));

    expect(host.stopGate({ outcome: 'pass', grounds: 'x' }).decision).toBe(
      'pass',
    );
    expect(host.stopGate({ outcome: 'pass' }).decision).toBe('block');
  });

  test('fanout seals raw text into opaque AgentText carrying the raw string', async () => {
    const host = new LiveHost(
      fakeDeps({ runFanout: () => ['out-a', 'out-b'] }),
    );
    const tasks: readonly FanoutTask[] = [{ agentType: 't', prompt: 'p' }];

    const out = await host.fanout(tasks);

    expect(out).toHaveLength(2);
    expect(`${out[0]}`).toBe('out-a');
    expect(`${out[1]}`).toBe('out-b');
  });

  test('readSidecar validates fail-closed', async () => {
    const schema = z.object({ n: z.number() });

    const ok = new LiveHost(fakeDeps({ readFile: () => '{"n":5}' }));
    await expect(ok.readSidecar('p', schema)).resolves.toEqual({ n: 5 });

    const bad = new LiveHost(fakeDeps({ readFile: () => '{"n":"x"}' }));
    await expect(bad.readSidecar('p', schema)).rejects.toThrow();
  });
});
