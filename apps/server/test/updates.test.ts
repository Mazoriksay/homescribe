import { afterEach, describe, expect, it } from 'vitest';
import { checkForUpdates } from '../src/updates';
import { startFakeOpenAi } from './support/fake-openai';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** GitHub's REST API as far as the check uses it. */
async function fakeGithub(routes: Record<string, unknown>) {
  const fake = await startFakeOpenAi((req, res) => {
    const body = routes[req.url];
    if (body === undefined) return res.writeHead(404).end('{"message":"Not Found"}');
    res.end(JSON.stringify(body));
  });
  closers.push(fake.close);
  return fake;
}

describe('checkForUpdates', () => {
  it('counts the changes on main since a latest image was built', async () => {
    const github = await fakeGithub({
      '/repos/o/r/compare/abc1234def...main': {
        ahead_by: 3,
        commits: [
          { sha: '1111111aaa', commit: { committer: { date: '2026-10-09T01:00:00Z' } } },
          { sha: '9e8a51ee6c', commit: { committer: { date: '2026-10-09T01:18:00Z' } } },
        ],
      },
    });
    const status = await checkForUpdates({
      repo: 'o/r',
      version: 'latest',
      commit: 'abc1234def',
      apiBase: github.baseUrl,
    });
    expect(status).toEqual({
      current: { version: 'latest', commit: 'abc1234def' },
      latest: { ref: '9e8a51e', date: '2026-10-09T01:18:00Z' },
      behind: 3,
      updateAvailable: true,
      error: null,
    });
    expect(github.received[0]).toMatchObject({ method: 'GET' });
  });

  it('says a build from main is current', async () => {
    const github = await fakeGithub({
      '/repos/o/r/compare/abc...main': { ahead_by: 0, commits: [] },
    });
    const status = await checkForUpdates({
      repo: 'o/r',
      version: 'latest',
      commit: 'abc',
      apiBase: github.baseUrl,
    });
    expect(status).toMatchObject({ behind: 0, updateAvailable: false, error: null });
  });

  it('compares a release image with the latest release', async () => {
    const github = await fakeGithub({
      '/repos/o/r/releases/latest': { tag_name: 'v0.4.0', published_at: '2026-10-10T00:00:00Z' },
    });
    const older = await checkForUpdates({
      repo: 'o/r',
      version: '0.3.1',
      commit: 'x',
      apiBase: github.baseUrl,
    });
    expect(older).toMatchObject({
      latest: { ref: 'v0.4.0' },
      updateAvailable: true,
      behind: null,
    });
    const same = await checkForUpdates({
      repo: 'o/r',
      version: '0.4.0',
      commit: 'x',
      apiBase: github.baseUrl,
    });
    expect(same.updateAvailable).toBe(false);
  });

  it('explains what it cannot compare', async () => {
    expect((await checkForUpdates({ repo: null, version: 'latest', commit: 'x' })).error).toBe(
      'off',
    );
    expect((await checkForUpdates({ repo: 'o/r', version: '0.0.0', commit: null })).error).toBe(
      'unknown_build',
    );
    const gone = await fakeGithub({});
    expect(
      (
        await checkForUpdates({
          repo: 'o/r',
          version: 'latest',
          commit: 'abc',
          apiBase: gone.baseUrl,
        })
      ).error,
    ).toBe('unreachable');
  });
});
