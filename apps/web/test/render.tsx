import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Provider } from 'react-redux';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { PrefsState } from '../src/app/prefs';
import { createStore } from '../src/app/store';
import { ThemeProvider } from '../src/theme/ThemeProvider';

type Route = { method?: string; path: string; status?: number; body?: unknown };

/** Replaces fetch with canned API answers; returns the mock to inspect calls. */
export function mockApi(routes: Route[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    const route = routes.find((r) => r.path === pathname && (r.method ?? 'GET') === request.method);
    if (!route) {
      return Response.json({ error: { code: 'NOT_FOUND', message: pathname } }, { status: 404 });
    }
    return route.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(route.body ?? {}, { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Renders `element` at `path` (matched by `pattern`) with store, theme and router. */
export function renderPage(
  element: ReactElement,
  { path = '/', pattern = '/', prefs = { locale: 'en', theme: 'light' } as PrefsState } = {},
) {
  const store = createStore(prefs);
  const router = createMemoryRouter([{ path: pattern, element }], { initialEntries: [path] });
  return render(
    <Provider store={store}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </Provider>,
  );
}
