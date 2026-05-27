import { executeHook } from '../src/hooks/io';
import { postToolUseHandler } from '../src/hooks/post-tool-use';

await executeHook(postToolUseHandler);
