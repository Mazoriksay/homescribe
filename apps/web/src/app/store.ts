import { configureStore } from '@reduxjs/toolkit';
import { api } from '../api/api';
import { loadPrefs, prefsSlice, savePrefs, type PrefsState } from './prefs';

export function createStore(initialPrefs?: PrefsState) {
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
  const store = configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      prefs: prefsSlice.reducer,
    },
    preloadedState: {
      prefs:
        initialPrefs ??
        loadPrefs(storage, typeof navigator === 'undefined' ? [] : navigator.languages),
    },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
  let saved = store.getState().prefs;
  store.subscribe(() => {
    const { prefs } = store.getState();
    if (prefs !== saved) {
      saved = prefs;
      savePrefs(storage, prefs);
    }
  });
  return store;
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
