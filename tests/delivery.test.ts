/**
 * Tests for the delivery layer - what `strata_get_context` actually hands back.
 *
 * These exist because of a measured failure, not a hypothetical one. On a 10-run benchmark
 * the Strata arm explored *more* of the repository than the control: the digest ended with
 * nine bare 40-character commit hashes, and the agent spent nine `git show` calls resolving
 * them - fetching commit subjects this database was already storing. The control never
 * opened the git history at all.
 *
 * Every assertion here pins one of the four defects that produced that result.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StrataDatabase } from '../src/storage/db.js';
import { StrataRepository, tokenizeQuery } from '../src/storage/repository.js';
import { ContextRetriever } from '../src/retrieval/context.js';
import { StrataRecord, GitCommitRecord } from '../src/schema/types.js';

const FULL_HASH_RE = /\b[0-9a-f]{40}\b/;

function commit(hash: string, message: string, files: string[] = ['src/a.ts']): GitCommitRecord {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    authorName: 'Dev',
    authorEmail: 'dev@test.com',
    authoredAt: 1_700_000_000,
    committerName: 'Dev',
    committerEmail: 'dev@test.com',
    committedAt: 1_700_000_000,
    message,
    changedFiles: files,
  };
}

function record(over: Partial<StrataRecord> & { id: string }): StrataRecord {
  return {
    schemaVersion: '0.1.0',
    title: 'Untitled',
    intent: 'No intent recorded',
    intentConfidence: 'DECLARED',
    author: { name: 'Dev', type: 'human' },
    // The schema requires at least one file; tests that care about file matching override it.
    files: [{ path: 'src/unrelated-placeholder.ts', changeType: 'modify' }],
    attempts: [],
    evidence: [],
    consequences: [],
    result: { status: 'success' },
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...over,
  } as StrataRecord;
}

describe('Query tokenisation (D2)', () => {
  it('splits on punctuation instead of deleting it', () => {
    // "104/136" must become two searchable numbers, not the token "104136", which is what
    // the old sanitiser produced and which matches nothing.
    expect(tokenizeQuery('bounds 104/136')).toEqual(['bounds', '104', '136']);
  });

  it('drops stopwords and single characters but keeps identifiers', () => {
    const t = tokenizeQuery('Make the gate configurable on generateDriftPlaylist');
    expect(t).toContain('generatedriftplaylist');
    expect(t).toContain('gate');
    expect(t).not.toContain('the');
    expect(t).not.toContain('on');
  });

  it('deduplicates so a repeated word cannot dominate the query', () => {
    expect(tokenizeQuery('drift drift drift')).toEqual(['drift']);
  });
});

describe('Delivery layer', () => {
  let db: StrataDatabase;
  let repo: StrataRepository;
  let retriever: ContextRetriever;

  beforeEach(() => {
    db = new StrataDatabase({ dbPath: ':memory:' });
    repo = new StrataRepository(db);
    retriever = new ContextRetriever(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe('D2 - a real task description must match', () => {
    it('finds the record a long natural-language task describes', () => {
      repo.saveRecord(record({
        id: 'REC-4',
        title: 'Hard Vibe Gate bounds',
        intent: 'The drift gate uses fixed BPM bounds of 104 and 136 by deliberate tuning',
        files: [{ path: 'src/utils/driftAlgorithm.ts', changeType: 'modify' }],
      }));

      // The whole sentence, as an agent would phrase it. Under the old AND-of-every-token
      // query this returned zero hits.
      const hits = repo.searchRecords(
        'Make the Hard Vibe Gate BPM bounds (104/136) configurable via an optional options ' +
          'parameter on generateDriftPlaylist, without changing existing caller behaviour'
      );

      expect(hits.map((h) => h.id)).toContain('REC-4');
    });

    it('ranks the record matching more of the query first', () => {
      repo.saveRecord(record({
        id: 'REC-NEAR',
        title: 'Drift gate BPM bounds tuning',
        intent: 'Drift gate BPM bounds 104 136 tuning',
      }));
      repo.saveRecord(record({
        id: 'REC-FAR',
        title: 'Frame engine routing',
        intent: 'Routing for the frame engine',
      }));

      const hits = repo.searchRecords('drift gate BPM bounds');
      expect(hits[0]?.id).toBe('REC-NEAR');
    });

    it('an FTS5 keyword in the task text does not break the query', () => {
      repo.saveRecord(record({ id: 'REC-1', title: 'Near miss handling', intent: 'x' }));
      expect(() => repo.searchRecords('handle a NEAR or NOT case')).not.toThrow();
    });
  });

  describe('D1 - never emit a reference the reader has to resolve', () => {
    it('replaces commit hashes with their subjects', () => {
      repo.saveGitCommits([
        commit('bd0872995c9e0f02ddbe4aa40fb14aa069726ab3', 'Fine-Tuning Drift Engine'),
        commit('3b8cefe9f879cddb53f69781e60da322c8ae60f4', '1st Draft for Drift engine is compelete'),
      ]);
      repo.saveRecord(record({
        id: 'REC-4',
        title: 'Drift gate',
        intent: 'Drift gate bounds',
        files: [{ path: 'src/utils/driftAlgorithm.ts', changeType: 'modify' }],
        evidence: [
          { type: 'git_commit', reference: 'bd0872995c9e0f02ddbe4aa40fb14aa069726ab3', confidence: 'VERIFIED' },
          { type: 'git_commit', reference: '3b8cefe9f879cddb53f69781e60da322c8ae60f4', confidence: 'VERIFIED' },
        ],
      }));

      const text = retriever.getTaskContext('drift gate bounds', []).formattedContext;

      expect(text).toContain('Fine-Tuning Drift Engine');
      expect(text).toContain('1st Draft for Drift engine is compelete');
      expect(text).toMatch(/bd08729/);
      // The regression that motivated all of this.
      expect(text).not.toMatch(FULL_HASH_RE);
    });

    it('drops a commit the cache cannot resolve rather than printing the hash', () => {
      repo.saveRecord(record({
        id: 'REC-9',
        title: 'Orphan evidence',
        intent: 'Cites a commit that was never indexed',
        evidence: [
          { type: 'git_commit', reference: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', confidence: 'VERIFIED' },
        ],
      }));

      const text = retriever.getTaskContext('orphan evidence', []).formattedContext;

      expect(text).not.toContain('deadbeef');
      expect(text).not.toContain('Commits:');
    });

    it('resolves an abbreviated hash against the full one', () => {
      repo.saveGitCommits([commit('bd0872995c9e0f02ddbe4aa40fb14aa069726ab3', 'Fine-Tuning Drift Engine')]);
      expect(repo.getCommitByHash('bd08729')?.message).toBe('Fine-Tuning Drift Engine');
      expect(repo.getCommitByHash('bd0872995c9e0f02ddbe4aa40fb14aa069726ab3')?.shortHash).toBe('bd08729');
      expect(repo.getCommitByHash('not-a-hash')).toBeNull();
      expect(repo.getCommitByHash('')).toBeNull();
    });
  });

  describe('D3 - return nothing rather than something irrelevant', () => {
    it('says so plainly when no record matches', () => {
      repo.saveRecord(record({ id: 'REC-1', title: 'Payment retries', intent: 'Retry policy' }));
      repo.saveRecord(record({ id: 'REC-2', title: 'Audio codecs', intent: 'Codec selection' }));

      const digest = retriever.getTaskContext('unrelated kubernetes ingress annotation', []);

      expect(digest.relevantRecords).toEqual([]);
      expect(digest.formattedContext).toContain('No recorded Strata context');
      // An honest miss has to be cheap, or the caller pays for being told nothing.
      expect(digest.formattedContext.length).toBeLessThan(200);
    });

    it('does not fall back to the most recent records', () => {
      for (let i = 1; i <= 5; i++) {
        repo.saveRecord(record({ id: `REC-${i}`, title: `Thing ${i}`, intent: `Intent ${i}` }));
      }
      const digest = retriever.getTaskContext('zzzz nonexistent subsystem', []);
      expect(digest.relevantRecords).toHaveLength(0);
    });
  });

  describe('D4 - rank, cap, and keep records whole', () => {
    beforeEach(() => {
      repo.saveRecord(record({
        id: 'REC-DRIFT',
        title: 'Drift gate bounds',
        intent: 'The drift gate BPM bounds are deliberate',
        files: [{ path: 'src/utils/driftAlgorithm.ts', changeType: 'modify' }],
        consequences: ['The rejection rate is the intended product behaviour'],
      }));
      repo.saveRecord(record({
        id: 'REC-LINEAGE',
        title: 'Engine lineage and routing',
        intent: 'Four engines exist; rise is unrouted',
        files: [{ path: 'src/controllers/engineController.ts', changeType: 'modify' }],
        consequences: ['The newest engine is not the routed one'],
      }));
    });

    it('a wrong file guess does not drag an unrelated record into the answer', () => {
      // The agent passes both files because it is guessing. Text relevance has to win.
      const digest = retriever.getTaskContext(
        'drift gate BPM bounds deliberate',
        ['src/utils/driftAlgorithm.ts', 'src/controllers/engineController.ts']
      );

      expect(digest.relevantRecords).toContain('REC-DRIFT');
      expect(digest.formattedContext).not.toContain('The newest engine is not the routed one');
    });

    it('attributes each constraint to the record it came from', () => {
      const text = retriever.getTaskContext('drift gate BPM bounds deliberate', []).formattedContext;
      const header = text.indexOf('**REC-DRIFT');
      const constraint = text.indexOf('The rejection rate is the intended product behaviour');
      expect(header).toBeGreaterThanOrEqual(0);
      expect(constraint).toBeGreaterThan(header);
    });

    it('caps the digest at three records', () => {
      for (let i = 1; i <= 8; i++) {
        repo.saveRecord(record({
          id: `REC-BULK-${i}`,
          title: 'Drift gate bounds variant',
          intent: 'The drift gate BPM bounds are deliberate',
        }));
      }
      const digest = retriever.getTaskContext('drift gate BPM bounds deliberate', []);
      expect(digest.relevantRecords.length).toBeLessThanOrEqual(3);
    });
  });
});
