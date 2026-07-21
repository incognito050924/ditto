import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { DriveStepInput, FanoutTask } from './host-adapter';
import {
  LiveHost,
  makeLiveHostDeps,
  type ClaudeSpawn,
  type HostDeps,
} from './live-host';

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

// ac-1: the SHIPPED seam must carry the autonomous-nested-session knobs so the
// integrated self-host drive uses no bespoke wrapper. These assert the exact
// argv/opts runDrive constructs from the injected config — no real CLI call
// (spawn is mocked to capture args/opts). Encodes: (1) --settings injects the
// Stop hook spawn-scoped (never editing the repo-global .claude/settings.json),
// (2) --dangerously-skip-permissions for headless autonomy, (3) cwd = ephemeral
// workspace, (4) the repo-global default leaves all knobs off (drive unchanged).
describe('makeLiveHostDeps autonomous-workspace flag construction (ac-1)', () => {
  const okJson = JSON.stringify({
    session_id: 'sess-live',
    structured_output: { queue: [] },
  });

  // Capture the argv + opts a single runDrive spawn is invoked with.
  function captureSpawn(): {
    spawn: ClaudeSpawn;
    calls: { args: string[]; opts: { cwd?: string; timeoutMs?: number } }[];
  } {
    const calls: { args: string[]; opts: { cwd?: string; timeoutMs?: number } }[] =
      [];
    const spawn: ClaudeSpawn = (args, opts) => {
      calls.push({ args: [...args], opts: { ...opts } });
      return okJson;
    };
    return { spawn, calls };
  }

  test('carries --settings <path>, --dangerously-skip-permissions, and cwd from config', () => {
    const { spawn, calls } = captureSpawn();
    const deps = makeLiveHostDeps(
      {
        cwd: '/ephemeral/ws',
        settingsPath: '/ephemeral/ws/inject-settings.json',
        skipPermissions: true,
        timeoutMs: 290_000,
      },
      spawn,
    );

    const out = deps.runDrive({ prompt: 'drive-one-step' });

    expect(calls).toHaveLength(1);
    const { args, opts } = calls[0]!;
    // --settings must carry EXACTLY the ephemeral settings path (spawn-scoped).
    const si = args.indexOf('--settings');
    expect(si).toBeGreaterThanOrEqual(0);
    expect(args[si + 1]).toBe('/ephemeral/ws/inject-settings.json');
    // headless autonomy flag present.
    expect(args).toContain('--dangerously-skip-permissions');
    // prompt is the final positional arg.
    expect(args[args.length - 1]).toBe('drive-one-step');
    // cwd + timeout are the ephemeral workspace / bound, driven by config.
    expect(opts.cwd).toBe('/ephemeral/ws');
    expect(opts.timeoutMs).toBe(290_000);
    // boundary still parsed from the (mocked) CLI JSON.
    expect(out.sessionId).toBe('sess-live');
  });

  test('repo-global default deps omit the autonomous knobs', () => {
    const { spawn, calls } = captureSpawn();
    const deps = makeLiveHostDeps({}, spawn);

    deps.runDrive({ prompt: 'ordinary' });

    const { args, opts } = calls[0]!;
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(opts.cwd).toBeUndefined();
  });

  test('--resume flows after the knobs and before the prompt', () => {
    const { spawn, calls } = captureSpawn();
    const deps = makeLiveHostDeps(
      { settingsPath: '/s.json', skipPermissions: true },
      spawn,
    );

    deps.runDrive({ prompt: 'p', resume: 'sess-9' });

    const { args } = calls[0]!;
    const ri = args.indexOf('--resume');
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(args[ri + 1]).toBe('sess-9');
    expect(args[args.length - 1]).toBe('p');
    // knobs precede --resume.
    expect(args.indexOf('--settings')).toBeLessThan(ri);
    expect(args.indexOf('--dangerously-skip-permissions')).toBeLessThan(ri);
  });
});
