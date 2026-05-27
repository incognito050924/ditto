import { executeHook } from '../src/hooks/io';
import { userPromptSubmitHandler } from '../src/hooks/user-prompt-submit';

await executeHook(userPromptSubmitHandler);
