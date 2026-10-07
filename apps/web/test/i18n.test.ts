import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { formatBytes, formatMessage, pickLocale } from '../src/i18n/format';
import { ru } from '../src/i18n/ru';

describe('dictionaries', () => {
  it('have the same keys and no empty strings', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...Object.values(en), ...Object.values(ru)]) {
      expect(value.trim()).not.toBe('');
    }
  });

  it('use the same placeholders in both languages', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(names(ru[key]), key).toEqual(names(en[key]));
    }
  });
});

describe('formatMessage', () => {
  it('fills placeholders', () => {
    expect(formatMessage('Page {page} of {pages}', 'en', { page: 2, pages: 5 })).toBe(
      'Page 2 of 5',
    );
  });

  it('picks plural forms per language', () => {
    expect(formatMessage(en['library.count'], 'en', { count: 1 })).toBe('1 recording');
    expect(formatMessage(en['library.count'], 'en', { count: 1284 })).toBe('1,284 recordings');
    expect(formatMessage(ru['library.count'], 'ru', { count: 1 })).toBe('1 запись');
    expect(formatMessage(ru['library.count'], 'ru', { count: 3 })).toBe('3 записи');
    expect(formatMessage(ru['library.count'], 'ru', { count: 11 })).toBe('11 записей');
    expect(formatMessage(ru['library.count'], 'ru', { count: 21 })).toBe('21 запись');
  });
});

describe('pickLocale', () => {
  it('uses the first supported browser language', () => {
    expect(pickLocale(['ru-RU', 'en-US'])).toBe('ru');
    expect(pickLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(pickLocale(['de-DE'])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });
});

describe('formatBytes', () => {
  it('uses binary units with sensible precision', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024, 'en')).toBe('250 MB');
    expect(formatBytes(3 * 1024 ** 3, 'en')).toBe('3 GB');
  });
});
