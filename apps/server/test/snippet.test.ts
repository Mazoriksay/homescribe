import { describe, expect, it } from 'vitest';
import { plainText } from '../src/db/search';
import { buildSnippet, searchTerms } from '../src/db/snippet';

describe('searchTerms', () => {
  it('lower-cases, strips punctuation and de-duplicates', () => {
    expect(searchTerms('  Бюджет, "Roadmap" бюджет!  ')).toEqual(['бюджет', 'roadmap']);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('buildSnippet', () => {
  const text =
    'We started with the weather. Then we talked about the budget for the office move and agreed ' +
    'to hire two people. The Budget review is next Friday. Finally, lunch plans were discussed.';

  it('centres on the first match and marks every match, case-insensitively', () => {
    const parts = buildSnippet(text, ['budget'], 80);
    const matches = parts.filter((p) => p.match).map((p) => p.text);
    expect(matches[0]).toBe('budget');
    expect(parts[0]).toEqual({ text: '…', match: false });
    expect(parts.map((p) => p.text).join('')).toContain('the budget for the office');
  });

  it('works for Cyrillic', () => {
    const parts = buildSnippet('Обсудили Бюджет на квартал', ['бюджет']);
    expect(parts).toEqual([
      { text: 'Обсудили ', match: false },
      { text: 'Бюджет', match: true },
      { text: ' на квартал', match: false },
    ]);
  });

  it('falls back to the start of the text without a match', () => {
    const parts = buildSnippet(text, ['zebra'], 40);
    expect(parts[0]?.text.startsWith('We started')).toBe(true);
    expect(parts.every((p) => !p.match)).toBe(true);
  });
});

describe('plainText', () => {
  it('drops Markdown markup but keeps the words', () => {
    expect(
      plainText(
        '# Plan\n\nShort sync about the **office move**.\n\n- The `budget` is *approved*\n1. [Notes](http://x) follow',
      ),
    ).toBe('Plan\nShort sync about the office move.\nThe budget is approved\nNotes follow');
  });
});
