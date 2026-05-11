import { personaPrompt } from '../prompts/persona';
import { providers } from '../providers';

export const siteAgent = {
  name: 'Assistant',
  model: providers.defaultChatModel,
  prompt: personaPrompt,
} as const;
