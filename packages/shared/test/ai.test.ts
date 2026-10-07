import { describe, expect, it } from 'vitest';
import {
  baseUrlSchema,
  classifyModel,
  summaryPayloadSchema,
  updateAiSettingsBodySchema,
} from '../src';

describe('classifyModel', () => {
  it('trusts the task field when the server sends one (speaches)', () => {
    expect(classifyModel('Systran/faster-whisper-large-v3', 'automatic-speech-recognition')).toBe(
      'stt',
    );
    expect(classifyModel('speaches-ai/Kokoro-82M-v1.0-ONNX', 'text-to-speech')).toBeNull();
  });

  it('guesses from the model id otherwise', () => {
    expect(classifyModel('whisper-1')).toBe('stt');
    expect(classifyModel('deepdml/faster-whisper-large-v3-turbo-ct2')).toBe('stt');
    expect(classifyModel('llama3.1:8b')).toBe('llm');
    expect(classifyModel('qwen2.5:14b-instruct')).toBe('llm');
    expect(classifyModel('nomic-embed-text:latest')).toBeNull();
  });
});

describe('baseUrlSchema', () => {
  it('normalises trailing slashes and a trailing /v1', () => {
    expect(baseUrlSchema.parse('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(baseUrlSchema.parse('https://api.openai.com/v1/')).toBe('https://api.openai.com');
    expect(baseUrlSchema.parse('https://api.groq.com/openai/v1')).toBe(
      'https://api.groq.com/openai',
    );
  });

  it('rejects other schemes, credentials and queries', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x', 'http://u:p@host', 'http://h/?a=1', 'x']) {
      expect(baseUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('updateAiSettingsBodySchema', () => {
  it('needs an address and a model unless turned off', () => {
    expect(updateAiSettingsBodySchema.safeParse({ mode: 'off' }).success).toBe(true);
    expect(updateAiSettingsBodySchema.safeParse({ mode: 'local' }).success).toBe(false);
    expect(
      updateAiSettingsBodySchema.safeParse({
        mode: 'local',
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1:8b',
      }).success,
    ).toBe(true);
  });
});

describe('summaryPayloadSchema', () => {
  it('trims, defaults action items and enforces limits', () => {
    expect(summaryPayloadSchema.parse({ summary: '  Plan agreed. ' })).toEqual({
      summary: 'Plan agreed.',
      actionItems: [],
    });
    expect(summaryPayloadSchema.safeParse({ summary: '' }).success).toBe(false);
    expect(
      summaryPayloadSchema.safeParse({ summary: 'x', actionItems: Array(51).fill('a') }).success,
    ).toBe(false);
  });
});
