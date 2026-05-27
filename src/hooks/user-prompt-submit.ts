import type { HookHandler } from './runtime';

/**
 * UserPromptSubmit hook handler (M1.3 fills the body).
 * M1.2: registered surface with a no-op pass-through so the manifest is fixed
 * and M1.3 only has to fill the projection/classification logic.
 */
export const userPromptSubmitHandler: HookHandler = () => ({ exitCode: 0 });
