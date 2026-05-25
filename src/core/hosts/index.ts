import { claudeCodeHostAdapter } from './claude-code';
import { codexHostAdapter } from './codex';
import { registerHostAdapter } from './types';

registerHostAdapter(codexHostAdapter);
registerHostAdapter(claudeCodeHostAdapter);

export * from './types';
export { claudeCodeHostAdapter, codexHostAdapter };
