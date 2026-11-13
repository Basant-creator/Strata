import { describe, it, expect } from 'vitest';
import {
  StrataRecordSchema,
  ConfidenceLevelSchema,
  AuthorSchema,
  AttemptSchema,
  EvidenceSchema,
} from '../src/schema/types.js';

describe('Strata Schema Validation', () => {
  it('validates confidence levels correctly', () => {
    expect(ConfidenceLevelSchema.parse('VERIFIED')).toBe('VERIFIED');
    expect(ConfidenceLevelSchema.parse('DECLARED')).toBe('DECLARED');
    expect(ConfidenceLevelSchema.parse('INFERRED')).toBe('INFERRED');
    expect(ConfidenceLevelSchema.parse('UNKNOWN')).toBe('UNKNOWN');
    expect(() => ConfidenceLevelSchema.parse('INVALID')).toThrow();
  });

  it('validates author identity with defaults', () => {
    const author = AuthorSchema.parse({ name: 'Basant Bhushan' });
    expect(author.name).toBe('Basant Bhushan');
    expect(author.type).toBe('human');
  });

  it('validates development attempts with failure reasons', () => {
    const attempt = AttemptSchema.parse({
      approach: 'Database row locking',
      status: 'failed',
      failureReason: 'Latency regression under load',
      confidence: 'VERIFIED',
    });
    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toBe('Latency regression under load');
  });

  it('validates evidence with references', () => {
    const evidence = EvidenceSchema.parse({
      type: 'git_commit',
      reference: 'a82f31c',
      description: 'Initial idempotency key implementation',
    });
    // Unlabelled evidence is a claim. It used to default to VERIFIED, which let evidence
    // nobody had checked carry the strongest label.
    expect(evidence.confidence).toBe('DECLARED');
    expect(evidence.type).toBe('git_commit');
  });

  it('validates a complete Strata Record', () => {
    const record = StrataRecordSchema.parse({
      id: 'REC-142',
      title: 'Prevent duplicate webhook processing',
      intent: 'Ensure at-most-once execution for incoming stripe webhooks',
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
          failureReason: 'Latency regression under 500 rps',
          confidence: 'VERIFIED',
        },
        {
          sequence: 2,
          approach: 'Redis distributed idempotency key',
          status: 'succeeded',
          confidence: 'VERIFIED',
        },
      ],
      evidence: [
        { type: 'git_commit', reference: 'a82f31c', confidence: 'VERIFIED' },
        { type: 'issue', reference: 'BUG-217', confidence: 'VERIFIED' },
      ],
      consequences: [
        'CHANGE-151 adjusted Redis TTL after an expiration edge case',
      ],
      result: {
        status: 'success',
        summary: '37/37 tests passed, latency < 15ms',
      },
    });

    expect(record.id).toBe('REC-142');
    expect(record.schemaVersion).toBe('0.1.0');
    expect(record.files).toHaveLength(2);
    expect(record.attempts).toHaveLength(2);
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it('rejects records without files', () => {
    expect(() =>
      StrataRecordSchema.parse({
        id: 'REC-1',
        title: 'Empty files record',
        intent: 'Test',
        author: { name: 'Dev' },
        files: [],
        result: { status: 'success' },
      })
    ).toThrow();
  });
});
