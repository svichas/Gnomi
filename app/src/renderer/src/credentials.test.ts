import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialProblem } from './credentials.ts';

test('credential errors from the engine and the providers point to the right Settings card', () => {
  const cases: [string, string, string][] = [
    ['The selected AI provider is not connected. Open Settings to add its API key or choose a connected provider under Model choices.', 'providers', 'Connect an AI provider'],
    ['Add an Anthropic key in Settings: the navigator runs on it', 'providers', 'Connect an AI provider'],
    ['No local endpoint is set. Add its URL in Settings.', 'providers', 'Set your local endpoint'],
    ['Anthropic answered 401: invalid x-api-key', 'providers', 'Anthropic rejected your key'],
    ['The persona writer could not propose an audience: OpenAI answered 403: forbidden', 'providers', 'OpenAI rejected your key'],
    ['Google answered 400: API key not valid. Please pass a valid API key.', 'providers', 'Google rejected your key'],
    ['OpenAI answered 429: You exceeded your current quota, please check your plan and billing details.', 'providers', 'OpenAI is out of credit'],
    ['Add a Figma access token in Settings first.', 'figma', 'Connect Figma first'],
    ['Figma does not accept this token. It is wrong, revoked or expired (tokens last 90 days at most).', 'figma', 'Your Figma token stopped working'],
  ];
  for (const [text, section, title] of cases) assert.deepEqual([credentialProblem(text)?.section, credentialProblem(text)?.title], [section, title], text);
});

test('other errors, including rate limits, are left alone', () => {
  for (const text of ['Anthropic answered 429: rate limited (gave up after 4 attempts)', 'That is not a Figma link.', 'Project saved.', 'Anthropic answered 500: overloaded']) assert.equal(credentialProblem(text), null, text);
});
