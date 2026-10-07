// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { postToParent, useEmbedSignals } from '../src/app/embedding';

afterEach(cleanup);

function Shell() {
  useEmbedSignals();
  return (
    <>
      <Link to="/settings">Settings</Link>
      <Outlet />
    </>
  );
}

describe('embed signals', () => {
  it('posts nothing when the app is not framed', () => {
    const spy = vi.spyOn(window, 'postMessage');
    postToParent({ source: 'homescribe', type: 'ready', path: '/' }, window);
    expect(spy).not.toHaveBeenCalled();
  });

  it('tells the parent it is ready, then every route change', () => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    const router = createMemoryRouter(
      [{ element: <Shell />, children: [{ path: '*', element: null }] }],
      { initialEntries: ['/recordings/abc?t=5'] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByText('Settings'));

    expect(parent.postMessage.mock.calls).toEqual([
      [{ source: 'homescribe', type: 'ready', path: '/recordings/abc?t=5' }, '*'],
      [{ source: 'homescribe', type: 'navigate', path: '/recordings/abc?t=5' }, '*'],
      [{ source: 'homescribe', type: 'navigate', path: '/settings' }, '*'],
    ]);
    vi.restoreAllMocks();
  });
});
