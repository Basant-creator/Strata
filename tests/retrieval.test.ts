import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StrataDatabase } from '../src/storage/db.js';
import { StrataRepository } from '../src/storage/repository.js';
import { FileExplainer } from '../src/retrieval/explainer.js';
import { ContextRetriever } from '../src/retrieval/context.js';
import { StrataRecord } from '../src/schema/types.js';

describe('Retrieval & Explainer Engine', () => {
  let db: StrataDatabase;
  let repo: StrataRepository;
  let explainer: FileExplainer;
  let contextRetriever: ContextRetriever;

  beforeEach(() => {
    db = new StrataDatabase({ dbPath: ':memory:' });
    repo = new StrataRepository(db);
    explainer = new FileExplainer(repo);
    contextRetriever = new ContextRetriever(repo);
  });

  afterEach(() => {
    db.close();
  });

  it('returns UNKNOWN explanation when no records or commits exist for a file', () => {
    const explanation = explainer.explainFile('unknown/path/to/mystery.ts');

    expect(explanation.overallConfidence).toBe('UNKNOWN');
    expect(explanation.why.confidence).toBe('UNKNOWN');
    expect(explanation.why.intent).toContain('UNKNOWN: No recorded evidence explains the original motivation');
    expect(explanation.rawText).toContain('[CONFIDENCE: UNKNOWN]');
  });

  it('returns INFERRED explanation when only raw Git commits exist', () => {
    repo.saveGitCommits([
      {
        hash: '1122334455667788',
        shortHash: '1122334',
        authorName: 'Developer One',
        authorEmail: 'dev@test.com',
        authoredAt: Date.now(),
        committerName: 'Developer One',
        committerEmail: 'dev@test.com',
        committedAt: Date.now(),
        message: 'fix: handle edge case in parser',
        changedFiles: ['src/parser.ts'],
      },
    ]);

    const explanation = explainer.explainFile('src/parser.ts');

    expect(explanation.overallConfidence).toBe('INFERRED');
    expect(explanation.why.confidence).toBe('INFERRED');
    expect(explanation.why.intent).toContain('Inferred from commit [1122334]');
    expect(explanation.who.authors).toContain('Developer One');
  });

  it('returns structured VERIFIED/DECLARED explanation with attempts and evidence', () => {
    const record: StrataRecord = {
      id: 'REC-142',
      schemaVersion: '0.1.0',
      title: 'Prevent duplicate webhook processing',
      intent: 'Prevent duplicate webhook processing and ensure idempotency',
      intentConfidence: 'DECLARED',
      author: {
        name: 'Basant Bhushan',
        email: 'basant@example.com',
        type: 'human',
      },
      agent: {
        name: 'Claude Code',
        model: 'claude-3-7-sonnet',
      },
      files: [
        { path: 'src/auth/middleware.ts', changeType: 'modify' },
        { path: 'src/auth/jwt.ts', changeType: 'modify' },
      ],
      attempts: [
        {
          sequence: 1,
          approach: 'Database row locking',
          status: 'failed',
          failureReason: 'Latency regression',
          confidence: 'VERIFIED',
        },
        {
          sequence: 2,
          approach: 'Idempotency key with Redis',
          status: 'succeeded',
          confidence: 'VERIFIED',
        },
      ],
      evidence: [
        { type: 'issue', reference: 'BUG-217', confidence: 'VERIFIED' },
        { type: 'benchmark', reference: 'BENCH-18', confidence: 'VERIFIED' },
        { type: 'git_commit', reference: 'a82f31', confidence: 'VERIFIED' },
      ],
      consequences: [
        'CHANGE-151 adjusted Redis TTL after an expiration edge case',
      ],
      result: {
        status: 'success',
        summary: '37/37 tests passed',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    repo.saveRecord(record);

    const explanation = explainer.explainFile('src/auth/middleware.ts');

    expect(explanation.overallConfidence).toBe('DECLARED');
    expect(explanation.why.intent).toContain('Prevent duplicate webhook processing');
    expect(explanation.who.authors).toContain('Basant Bhushan');
    expect(explanation.who.agents[0]).toContain('Claude Code');
    expect(explanation.how.approaches).toHaveLength(2);
    expect(explanation.how.approaches[0]?.status).toBe('failed');
    expect(explanation.evidence).toHaveLength(3);
    expect(explanation.consequences).toHaveLength(1);
    expect(explanation.rawText).toContain('## HOW (Attempts & Decisions)');
    expect(explanation.rawText).toContain('[FAILED] Database row locking -> Latency regression');
    expect(explanation.rawText).toContain('37/37 tests passed');
  });

  it('retrieves minimum sufficient context for AI tasks including failed attempts warning', () => {
    const record: StrataRecord = {
      id: 'REC-200',
      schemaVersion: '0.1.0',
      title: 'Payment timeout fix',
      intent: 'Fix payment timeout when upstream gateway is slow',
      intentConfidence: 'DECLARED',
      author: { name: 'Payment Lead', type: 'human' },
      files: [{ path: 'src/payment/gateway.ts', changeType: 'modify' }],
      attempts: [
        {
          sequence: 1,
          approach: 'Synchronous retry loop',
          status: 'failed',
          failureReason: 'Cascading socket exhaustion',
          confidence: 'VERIFIED',
        },
        {
          sequence: 2,
          approach: 'Exponential backoff with jitter and circuit breaker',
          status: 'succeeded',
          confidence: 'VERIFIED',
        },
      ],
      evidence: [{ type: 'git_commit', reference: '99aabb', confidence: 'VERIFIED' }],
      consequences: ['Requires CircuitBreaker configuration in environment'],
      result: { status: 'success', summary: 'All gateway integration tests passed' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    repo.saveRecord(record);

    const context = contextRetriever.getTaskContext('Fix payment gateway timeout', ['src/payment/gateway.ts']);

    expect(context.relevantFiles).toContain('src/payment/gateway.ts');
    expect(context.failedAttempts).toHaveLength(1);
    expect(context.failedAttempts[0]?.approach).toBe('Synchronous retry loop');
    expect(context.consequencesAndConstraints).toContain('Requires CircuitBreaker configuration in environment');
    expect(context.formattedContext).toContain('Past Failed Attempts (DO NOT REPEAT)');
    expect(context.formattedContext).toContain('Cascading socket exhaustion');
  });
});
