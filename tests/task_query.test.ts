import { describe, it, expect } from 'vitest';
import { extractTaskQuery } from '../src/integrations/task-query.js';
import { splitClauses, tokenize } from '../src/code/graph.js';

/**
 * What the task-start hook hands the resolver.
 *
 * The hook receives a whole prompt, and the resolver scores every word it is given.
 * Measured on three controlled tasks, the clause "why. Answer only" resolved by itself
 * to an unrelated test file on "answer" and "only", in all three; the wrapper sentence
 * added "answer", "question", "below", "about" and "repository" to the words every file
 * was scored against. These tests hold the extraction to removing exactly that kind of
 * text, and nothing that could name what the question is about.
 */

const WRAPPER = 'Answer the question below about this repository.\n\n';

// Frozen: copied here, never edited.
const T4 = 'The backend evaluation scripts reference more than one benchmark dataset. Determine whether one dataset replaced the other or whether both are still in use, and justify your answer with specifics. Answer only; do not edit files.';
const T5 = 'The drift engine gates tracks by tempo. Has this engine ever gated tempo by a different method than the one it uses now? If so, describe the earlier method and what became of it. Answer only; do not edit files.';
const T6 = 'backend/src/server.ts configures a CORS allow-list. For each entry, state whether it is still required by the current application and why. Answer only; do not edit files.';
const T1 = 'In backend/src/utils/trackUtils.ts, describe what the exported functions do and what inputs they handle. List every exported symbol. Answer only; do not edit files.';
const T2 = 'Which files in this repository call generateDriftPlaylist, and what would break if that function gained a required second parameter? Answer only; do not edit files.';

describe('what is removed', () => {
  it('T4: the wrapper, the instruction to justify, and the reply directives', () => {
    const r = extractTaskQuery(WRAPPER + T4);
    expect(r.query).toBe('The backend evaluation scripts reference more than one benchmark dataset. '
      + 'Determine whether one dataset replaced the other or whether both are still in use');
    expect(r.removed).toEqual(['Answer the question below about this repository.',
      'and justify your answer with specifics.', 'Answer only', 'do not edit files.']);
  });

  it('T5: the wrapper and the reply directives, and nothing of the question', () => {
    const r = extractTaskQuery(WRAPPER + T5);
    expect(r.query).toBe('The drift engine gates tracks by tempo. Has this engine ever gated tempo by '
      + 'a different method than the one it uses now? If so; describe the earlier method; what became of it.');
  });

  it('T6: the wrapper and the reply directives; the path is untouched', () => {
    const r = extractTaskQuery(WRAPPER + T6);
    expect(r.query).toBe('backend/src/server.ts configures a CORS allow-list. For each entry; state '
      + 'whether it is still required by the current application; why.');
  });

  it('no word the resolver would score survives from the removed text', () => {
    const exchange = ['answer', 'question', 'below', 'about', 'repository', 'only', 'edit', 'files', 'justify', 'specifics'];
    for (const task of [T4, T5, T6]) {
      const terms = tokenize(extractTaskQuery(WRAPPER + task).query);
      for (const w of exchange) expect(terms).not.toContain(w);
    }
  });

  it('is generic: wrappers worded unlike any frozen task are removed the same way', () => {
    expect(extractTaskQuery(
      'Please answer the following question about the codebase:\n\nWhy does the ledger drop refunds?\n\n'
      + "Don't edit any files. Be brief.").query).toBe('Why does the ledger drop refunds?');
    expect(extractTaskQuery('Question: why is the retry budget reset on login? Be concise.').query)
      .toBe('why is the retry budget reset on login?');
    expect(extractTaskQuery('Explain your reasoning.\nWhere is the session cookie signed?').query)
      .toBe('Where is the session cookie signed?');
  });
});

describe('what is never removed', () => {
  it('a prompt with nothing to remove comes back byte-for-byte', () => {
    for (const p of [
      'fix the CORS handling in src/web/server.ts and keep the stock ledger behaviour',
      'Make cache lookups reliable in backend/src/services/trackCacheService.ts, and do not break normalizeTrackKey.',
      'Why is the policy in src/gate/policy.ts closed by default?',
      'generateDriftPlaylist',
      'src/priceCacheService.ts',
    ]) {
      const r = extractTaskQuery(p);
      expect(r.query).toBe(p);
      expect(r.removed).toEqual([]);
    }
  });

  it('explicit paths and symbols are preserved exactly', () => {
    expect(extractTaskQuery(WRAPPER + T1).query).toContain('backend/src/utils/trackUtils.ts');
    expect(extractTaskQuery(WRAPPER + T2).query).toContain('generateDriftPlaylist');
    expect(extractTaskQuery('Do not edit files; explain why MAX_BPM_FLIGHT_VARIANCE was removed').query)
      .toBe('explain why MAX_BPM_FLIGHT_VARIANCE was removed');
  });

  it('a piece that names something is kept, however exchange-like its other words', () => {
    // A path, a backticked span, and code-shaped identifiers, each alone among exchange words.
    for (const p of ['Answer only about src/gate/policy.ts', 'Answer only about `only`',
                     'Do not edit answerFiles', 'Do not edit edit_files', 'Answer only for v2Files']) {
      expect(extractTaskQuery(`Why is the gate closed?; ${p}`).query).toContain(p);
    }
  });

  it('a piece with a single subject word is kept verbatim', () => {
    // "describe" is an exchange word; "earlier method" is the question.
    expect(extractTaskQuery(WRAPPER + T5).query).toContain('describe the earlier method');
  });

  it('words that name things in real codebases are not treated as wrapper text', () => {
    // Deliberately absent from the list: each is the subject of a question somewhere.
    for (const p of ['fix the task list', 'the request handler', 'the response body', 'the list state', 'the code path']) {
      expect(extractTaskQuery(`Answer only; ${p}`).query).toBe(p);
    }
  });

  it('a prompt that is nothing but exchange words comes back whole', () => {
    for (const p of ['Answer the question.', 'Answer only; do not edit files.']) {
      // Exchange words alone are not conversation: the prompt still goes through whole.
      expect(extractTaskQuery(p)).toEqual({ query: p, removed: [], conversational: false });
    }
  });

  it("keeps the resolver's clause structure", () => {
    // The resolver resolves each clause separately; regrouping would change the answer
    // for reasons that have nothing to do with the wrapper.
    expect(splitClauses(extractTaskQuery(WRAPPER + T5).query)).toEqual([
      'The drift engine gates tracks by tempo. Has this engine ever gated tempo by a different method than the one it uses now? If so',
      'describe the earlier method',
      'what became of it.',
    ]);
  });
});
