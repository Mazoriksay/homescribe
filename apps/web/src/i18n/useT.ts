import { useCallback } from 'react';
import { useAppSelector } from '../app/hooks';
import { en, type MessageKey } from './en';
import { formatMessage } from './format';
import { ru } from './ru';

const dictionaries = { en, ru } as const;

export function useLocale() {
  return useAppSelector((state) => state.prefs.locale);
}

/** Returns `t(key, values)` for the current locale. */
export function useT() {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, values?: Record<string, string | number>) =>
      formatMessage(dictionaries[locale][key], locale, values),
    [locale],
  );
}

/** Translation key for an error code, falling back to a generic message. */
export function errorMessageKey(code: string): MessageKey {
  const key = `error.${code}`;
  return key in en ? (key as MessageKey) : 'error.unknown';
}
