import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StrataDatabase } from '../src/storage/db.js';
import { StrataRepository } from '../src/storage/repository.js';
import { StrataRecord } from '../src/schema/types.js';

describe('Strata SQLite Storage & Repository', () => {
  let db: StrataDatabase;
  let repo: StrataRepository;

  beforeEach(() => {
    db = new StrataDatabase({ dbPath: ':memory:' });
    repo = new StrataRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  const sampleRecord: StrataRecord = {
    id: 'REC-101',
    schemaVersion: '0.1.0',
    title: 'Add rate limiting to auth routes',
    intent: 'Mitigate brute force attacks on login endpoints',
    intentConfidence: 'DECLARED',
    author: {
      name: 'Alice Developer',
      email: 'alice@example.com',
      type: 'human',
    },
    agent: {
      name: 'Antigravity',
      model: 'gemini-3.7-flash',
    },
    files: [
      { path: 'src/routes/auth.ts', changeType: 'modify', symbols: ['loginHandler'] },
      { path: 'src/config/rateLimit.ts', changeType: 'add' },
    ],
    attempts: [
      {
        sequence: 1,
        approach: 'In-memory token bucket',
        status: 'failed',
        failureReason: 'Does not scale across multiple cluster instances',
        confidence: 'VERIFIED',
      },
      {
        sequence: 2,
        approach: 'Redis sliding window counter',
        status: 'succeeded',
        confidence: 'VERIFIED',
      },
    ],
    evidence: [
      { type: 'git_commit', reference: 'c0ffee1', confidence: 'VERIFIED' },
      { type: 'test_run', reference: 'RUN-99', description: '42 tests passed', confidence: 'VERIFIED' },
    ],
    consequences: ['Requires Redis connection string in production config'],
    result: {
      status: 'success',
      summary: '42/42 tests passing',
    },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };

  it('saves and retrieves a record by ID', () => {
    repo.saveRecord(sampleRecord);
    const retrieved = repo.getRecordById('REC-101');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('REC-101');
    expect(retrieved?.intent).toBe('Mitigate brute force attacks on login endpoints');
    expect(retrieved?.author.name).toBe('Alice Developer');
    expect(retrieved?.agent?.name).toBe('Antigravity');
    expect(retrieved?.files).toHaveLength(2);
    expect(retrieved?.attempts).toHaveLength(2);
    expect(retrieved?.evidence).toHaveLength(2);
    expect(retrieved?.consequences).toHaveLength(1);
    expect(retrieved?.result.status).toBe('success');
  });

  it('retrieves records by affected file', () => {
    repo.saveRecord(sampleRecord);

    const authRecords = repo.getRecordsByFile('src/routes/auth.ts');
    expect(authRecords).toHaveLength(1);
    expect(authRecords[0]?.id).toBe('REC-101');

    const configRecords = repo.getRecordsByFile('src/config/rateLimit.ts');
    expect(configRecords).toHaveLength(1);

    const unrelatedRecords = repo.getRecordsByFile('src/unrelated.ts');
    expect(unrelatedRecords).toHaveLength(0);
  });

  it('performs full-text search with FTS5', () => {
    repo.saveRecord(sampleRecord);

    const searchResults = repo.searchRecords('brute force');
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.id).toBe('REC-101');

    const redisSearch = repo.searchRecords('Redis');
    expect(redisSearch).toHaveLength(1);

    const missSearch = repo.searchRecords('nonexistenttermxyz');
    expect(missSearch).toHaveLength(0);
  });

  it('caches and queries Git commits', () => {
    repo.saveGitCommits([
      {
        hash: 'c0ffee1122334455',
        shortHash: 'c0ffee1',
        authorName: 'Alice Developer',
        authorEmail: 'alice@example.com',
        authoredAt: 1700000000000,
        committerName: 'Alice Developer',
        committerEmail: 'alice@example.com',
        committedAt: 1700000000000,
        message: 'feat: add rate limiting to auth',
        changedFiles: ['src/routes/auth.ts', 'src/config/rateLimit.ts'],
      },
    ]);

    expect(repo.getGitCommitCount()).toBe(1);

    const commits = repo.getGitCommitsByFile('src/routes/auth.ts');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.shortHash).toBe('c0ffee1');
  });
});
