import type { DatabaseSync } from 'node:sqlite';
import type { SearchMode } from '@homescribe/shared';
import { searchTerms } from './snippet';

/** True when the SQLite bundled with Node was built with FTS5. */
export function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

export interface SearchMatch {
  recordingId: string;
  title: string;
  body: string;
}

const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Full-text index over recording titles, transcripts and summaries. Uses
 * FTS5 when available (ranked, word-prefix matches); otherwise a LIKE scan
 * over lower-cased copies (substring matches, newest first). SPEC.md §7.3.
 */
export class SearchIndex {
  readonly mode: SearchMode;

  constructor(
    private readonly db: DatabaseSync,
    options: { forceLike?: boolean } = {},
  ) {
    this.mode = !options.forceLike && hasFts5(db) ? 'fts5' : 'like';
    if (this.mode === 'fts5') this.ensureFtsTable();
    // Recordings from before the index existed (or after a crash) get indexed now.
    const missing = db
      .prepare(
        `SELECT r.id FROM recordings r
         LEFT JOIN search_docs d ON d.recording_id = r.id WHERE d.recording_id IS NULL`,
      )
      .all() as { id: string }[];
    for (const { id } of missing) this.refresh(id);
  }

  private ensureFtsTable(): void {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      recording_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')`);
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    if (
      count('SELECT COUNT(*) AS n FROM search_fts') !==
      count('SELECT COUNT(*) AS n FROM search_docs')
    ) {
      this.db.exec(`DELETE FROM search_fts;
        INSERT INTO search_fts (recording_id, title, body)
          SELECT recording_id, title, body FROM search_docs;`);
    }
  }

  /** Rebuilds the entry of one recording from its title, transcript and summary. */
  refresh(recordingId: string): void {
    const row = this.db
      .prepare(
        `SELECT r.title, t.text AS transcript, s.summary, s.action_items
         FROM recordings r
         LEFT JOIN transcripts t ON t.recording_id = r.id
         LEFT JOIN summaries s ON s.recording_id = r.id
         WHERE r.id = ?`,
      )
      .get(recordingId) as
      | {
          title: string;
          transcript: string | null;
          summary: string | null;
          action_items: string | null;
        }
      | undefined;
    if (!row) return;
    const actionItems = row.action_items ? (JSON.parse(row.action_items) as string[]) : [];
    const body = [row.transcript, row.summary, ...actionItems].filter(Boolean).join('\n\n');
    this.db
      .prepare(
        `INSERT OR REPLACE INTO search_docs (recording_id, title, body, title_lc, body_lc)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(recordingId, row.title, body, row.title.toLowerCase(), body.toLowerCase());
    if (this.mode === 'fts5') {
      this.db.prepare('DELETE FROM search_fts WHERE recording_id = ?').run(recordingId);
      this.db
        .prepare('INSERT INTO search_fts (recording_id, title, body) VALUES (?, ?, ?)')
        .run(recordingId, row.title, body);
    }
  }

  remove(recordingId: string): void {
    this.db.prepare('DELETE FROM search_docs WHERE recording_id = ?').run(recordingId);
    if (this.mode === 'fts5') {
      this.db.prepare('DELETE FROM search_fts WHERE recording_id = ?').run(recordingId);
    }
  }

  query(query: string, page: number, pageSize: number): { total: number; matches: SearchMatch[] } {
    const terms = searchTerms(query);
    if (terms.length === 0) return { total: 0, matches: [] };
    const offset = (page - 1) * pageSize;

    if (this.mode === 'fts5') {
      // Every term as a quoted prefix query: no FTS syntax from users reaches SQLite.
      const match = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');
      const { n } = this.db
        .prepare('SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ?')
        .get(match) as { n: number };
      const rows = this.db
        .prepare(
          `SELECT recording_id AS recordingId, title, body FROM search_fts
           WHERE search_fts MATCH ? ORDER BY bm25(search_fts, 0, 5, 1) LIMIT ? OFFSET ?`,
        )
        .all(match, pageSize, offset) as unknown as SearchMatch[];
      return { total: n, matches: rows };
    }

    const where = terms
      .map(() => `(d.title_lc LIKE ? ESCAPE '\\' OR d.body_lc LIKE ? ESCAPE '\\')`)
      .join(' AND ');
    const params = terms.flatMap((term) => {
      const like = `%${escapeLike(term)}%`;
      return [like, like];
    });
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM search_docs d WHERE ${where}`)
      .get(...params) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT d.recording_id AS recordingId, d.title, d.body FROM search_docs d
         JOIN recordings r ON r.id = d.recording_id
         WHERE ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as unknown as SearchMatch[];
    return { total: n, matches: rows };
  }
}
