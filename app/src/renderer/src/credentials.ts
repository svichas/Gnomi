/** The Settings card an error can send the user to. */
export type SettingsSection = 'providers' | 'figma';

export interface CredentialProblem {
  section: SettingsSection;
  title: string;
  /** Only for a provider's raw answer, which then shows beneath it; the engine's own messages already say what to do. */
  hint?: string;
}

const PROVIDER = /\b(Anthropic|OpenAI|Google|DeepSeek)\b/;

// Matched on the messages the engine already writes (simulation/src/llm/gateway.ts, engine/src/host.ts, engine/src/figma/client.ts)
// and the providers' own 401/403/quota wording. shortcut: string matching, move to an error kind on the IPC response if these drift.
export function credentialProblem(text: string): CredentialProblem | null {
  if (/Add a Figma access token/.test(text)) return { section: 'figma', title: 'Connect Figma first' };
  if (/Figma does not accept this token|file_content:read scope/.test(text)) {
    return { section: 'figma', title: 'Your Figma token stopped working' };
  }
  const provider = text.match(PROVIDER)?.[1] ?? 'Your AI provider';
  if (/insufficient_quota|credit balance is too low|exceeded your current quota/i.test(text)) {
    return { section: 'providers', title: `${provider} is out of credit`, hint: 'Add credit with the provider, or choose another connected provider under Model choices.' };
  }
  if (/answered 40[13]\b|rejected this key|API key not valid|invalid x-api-key|incorrect API key/i.test(text)) {
    return { section: 'providers', title: provider === 'Your AI provider' ? 'Your AI key was rejected' : `${provider} rejected your key`, hint: 'It may have been revoked, expired or pasted incompletely. Replace it with a new key and test it.' };
  }
  if (/AI provider is not connected|Add an? \w+ key in Settings|^No key saved$/.test(text)) {
    return { section: 'providers', title: 'Connect an AI provider' };
  }
  if (/No local endpoint is set|Set the local model endpoint/.test(text)) {
    return { section: 'providers', title: 'Set your local endpoint' };
  }
  return null;
}
