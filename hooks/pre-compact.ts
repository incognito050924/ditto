import { executeHook } from '../src/hooks/io';
import { noOpHandler } from '../src/hooks/runtime';

// PreCompact runtime (handoff projection) is post-v0 (M4); registered no-op stub.
await executeHook(noOpHandler);
