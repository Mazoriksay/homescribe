import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { Repository } from '../src/db/repository';
import { hasFts5 } from '../src/db/search';

function setup(forceLikeSearch: boolean) {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const repo = new Repository(openDatabase(':memory:'), () => new Date((clock += 1000)), {
    forceLikeSearch,
  });
  const add = (title: string, text: string) => {
    const id = randomUUID();
    repo.createRecording({
      id,
      title,
      originalFilename: `${title}.m4a`,
      mediaType: 'audio/mp4',
      sizeBytes: 1,
      storedName: 'original.m4a',
    });
    repo.saveTranscript(id, {
      language: null,
      model: 'm',
      text,
      segments: [{ start: 0, end: 1, text }],
    });
    return id;
  };
  return { repo, add };
}

const modes = [
  ['like', true],
  ...(hasFts5(openDatabase(':memory:')) ? [['fts5', false] as const] : []),
] as const;

describe.each(modes)('search (%s)', (mode, forceLike) => {
  it('reports its mode', () => {
    expect(setup(forceLike).repo.search.mode).toBe(mode);
  });

  it('finds words in transcripts, titles and summaries, case-insensitively', () => {
    const { repo, add } = setup(forceLike);
    const budget = add('Planning', 'Обсудили Бюджет на квартал');
    const title = add('Budget review', 'Nothing relevant here');
    const summary = add('Standup', 'Short call');
    repo.saveSummary(summary, { summary: 'Agreed on the budget.', actionItems: [], model: 'm' });
    add('Lunch', 'Pizza or sushi');

    expect(repo.search.query('бюджет', 1, 10).matches.map((m) => m.recordingId)).toEqual([budget]);
    expect(new Set(repo.search.query('BUDGET', 1, 10).matches.map((m) => m.recordingId))).toEqual(
      new Set([title, summary]),
    );
  });

  it('treats ё and е as the same letter and keeps the original text', () => {
    const { repo, add } = setup(forceLike);
    const tree = add('Ёлка', 'Купили ёлку');
    const plain = add('Елки', 'Елки-палки');
    expect(new Set(repo.search.query('елк', 1, 10).matches.map((m) => m.recordingId))).toEqual(
      new Set([tree, plain]),
    );
    const [match] = repo.search.query('ЁЛКУ', 1, 10).matches;
    expect(match).toMatchObject({ recordingId: tree, title: 'Ёлка', body: 'Купили ёлку' });
  });

  it('requires every term and matches word prefixes', () => {
    const { repo, add } = setup(forceLike);
    const both = add('a', 'hiring two engineers next month');
    add('b', 'hiring freeze');
    expect(repo.search.query('hir engineers', 1, 10).matches.map((m) => m.recordingId)).toEqual([
      both,
    ]);
  });

  it('treats operators and quotes in the query as plain text', () => {
    const { repo, add } = setup(forceLike);
    add('a', 'plain text');
    for (const q of ['"', 'NOT', 'a OR b', '*', 'col:x', '100%', '_']) {
      expect(() => repo.search.query(q, 1, 10), q).not.toThrow();
    }
  });

  it('paginates and drops deleted or renamed recordings from old results', () => {
    const { repo, add } = setup(forceLike);
    const ids = [add('one', 'note alpha'), add('two', 'note beta'), add('three', 'note gamma')];
    const page = repo.search.query('note', 2, 2);
    expect(page.total).toBe(3);
    expect(page.matches).toHaveLength(1);

    repo.deleteRecording(ids[0]!);
    expect(repo.search.query('alpha', 1, 10).total).toBe(0);
    repo.renameRecording(ids[1]!, 'Quarterly');
    expect(repo.search.query('quarterly', 1, 10).matches[0]?.recordingId).toBe(ids[1]);
  });
});

it('indexes recordings created before the index existed', () => {
  const db = openDatabase(':memory:');
  const repo = new Repository(db);
  const id = randomUUID();
  repo.createRecording({
    id,
    title: 'Old note',
    originalFilename: 'x.m4a',
    mediaType: 'audio/mp4',
    sizeBytes: 1,
    storedName: 'original.m4a',
  });
  db.exec('DELETE FROM search_docs');
  expect(new Repository(db).search.query('old', 1, 10).total).toBe(1);
});
