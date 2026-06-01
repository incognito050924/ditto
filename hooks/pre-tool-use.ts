import { executeHook } from '../src/hooks/io';
import { preToolUseHandler } from '../src/hooks/pre-tool-use';

await executeHook(preToolUseHandler);
