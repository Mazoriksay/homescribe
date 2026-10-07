import { describe, expect, it } from 'vitest';
import { loadPrefs, savePrefs, withUrlOverrides } from '../src/app/prefs';
import { resolveTheme } from '../src/theme/theme';

describe('resolveTheme', () => {
  it('follows the system in auto mode', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('prefs persistence', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it('defaults to the browser language and auto theme', () => {
    expect(loadPrefs(memory(), ['ru'])).toEqual({ locale: 'ru', theme: 'auto' });
  });

  it('round-trips saved preferences', () => {
    const storage = memory();
    savePrefs(storage, { locale: 'en', theme: 'dark' });
    expect(loadPrefs(storage, ['ru'])).toEqual({ locale: 'en', theme: 'dark' });
  });

  it('survives broken or unavailable storage', () => {
    const broken = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadPrefs(broken, ['en'])).toEqual({ locale: 'en', theme: 'auto' });
    expect(() => savePrefs(broken, { locale: 'en', theme: 'auto' })).not.toThrow();
    expect(loadPrefs(undefined, [])).toEqual({ locale: 'en', theme: 'auto' });
  });
});

describe('withUrlOverrides', () => {
  const saved = { locale: 'en', theme: 'light' } as const;

  it('lets an embedding page set language and theme', () => {
    expect(withUrlOverrides(saved, '?lang=ru&theme=dark')).toEqual({ locale: 'ru', theme: 'dark' });
  });

  it('ignores missing or unknown values', () => {
    expect(withUrlOverrides(saved, '')).toEqual(saved);
    expect(withUrlOverrides(saved, '?lang=de&theme=neon')).toEqual(saved);
  });
});
