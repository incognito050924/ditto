import { executeHook } from '../src/hooks/io';
import { noOpHandler } from '../src/hooks/runtime';

// PostToolUse runtime (evidence collection) is post-v0 (M3); registered no-op stub.
await executeHook(noOpHandler);
