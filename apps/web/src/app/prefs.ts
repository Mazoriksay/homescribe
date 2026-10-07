import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { pickLocale, type Locale } from '../i18n/format';
import type { ThemePreference } from '../theme/theme';

export interface PrefsState {
  locale: Locale;
  theme: ThemePreference;
}

const STORAGE_KEY = 'homescribe.prefs';

/** Reads saved preferences; storage may be unavailable (private mode), so never throw. */
export function loadPrefs(
  storage: Pick<Storage, 'getItem'> | undefined,
  languages: readonly string[],
): PrefsState {
  const fallback: PrefsState = { locale: pickLocale(languages), theme: 'auto' };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<PrefsState>;
    return {
      locale: saved.locale === 'en' || saved.locale === 'ru' ? saved.locale : fallback.locale,
      theme:
        saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'auto'
          ? saved.theme
          : fallback.theme,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(storage: Pick<Storage, 'setItem'> | undefined, prefs: PrefsState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisting is acceptable.
  }
}

export const prefsSlice = createSlice({
  name: 'prefs',
  initialState: (): PrefsState => ({ locale: 'en', theme: 'auto' }),
  reducers: {
    setLocale(state, action: PayloadAction<Locale>) {
      state.locale = action.payload;
    },
    setTheme(state, action: PayloadAction<ThemePreference>) {
      state.theme = action.payload;
    },
  },
});

export const { setLocale, setTheme } = prefsSlice.actions;
