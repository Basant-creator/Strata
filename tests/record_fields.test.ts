import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import {
  splitFields,
  parseAttempt,
  parseConstraint,
  parseEvidence,
  parseFailedAttempt,
} from '../src/cli/record-fields.js';
import { registerRecordCommand } from '../src/cli/commands/record.js';
import { StrataService } from '../src/records/service.js';

/**
 * Parsing of `strata record`'s colon-separated options.
 *
 * These were read with `split(':')`, so a colon inside the text ended a field and the
 * text after the next one was dropped silently. The cases below are the shapes that
 * lost text: prose with colons, error messages, URLs, Windows paths. Each one asserts
 * the full text survives, and the README's own examples pin that well-formed input
 * reads exactly as it did before.
 */
describe('splitFields', () => {
  it('splits on colons', () => {
    expect(splitFields('a:b:c')).toEqual(['a', 'b', 'c']);
  });

  it('reads \\: as a literal colon', () => {
    expect(splitFields('a\\:b:c')).toEqual(['a:b', 'c']);
  });

  it('keeps a URL whole, port included', () => {
    expect(splitFields('issue:https://github.com/o/r/issues/12:report'))
      .toEqual(['issue', 'https://github.com/o/r/issues/12', 'report']);
    expect(splitFields('log:http://localhost:8080/x:served'))
      .toEqual(['log', 'http://localhost:8080/x', 'served']);
  });

  it('keeps a Windows drive path whole, with either slash', () => {
    expect(splitFields('log:C:\\logs\\run.txt:d')).toEqual(['log', 'C:\\logs\\run.txt', 'd']);
    expect(splitFields('log:D:/work/run.txt:d')).toEqual(['log', 'D:/work/run.txt', 'd']);
  });

  it('leaves a backslash that does not escape a colon alone', () => {
    expect(splitFields('a\\b:c')).toEqual(['a\\b', 'c']);
  });
});

describe('parseConstraint', () => {
  it('reads the README example as before', () => {
    expect(parseConstraint('handleWebhook must stay idempotent:DECLARED:ACTIVE')).toMatchObject({
      statement: 'handleWebhook must stay idempotent', confidence: 'DECLARED', status: 'ACTIVE',
    });
  });

  it('keeps colons inside the statement', () => {
    expect(parseConstraint('Keep it idempotent: retries happen:DECLARED:ACTIVE')).toMatchObject({
      statement: 'Keep it idempotent: retries happen', confidence: 'DECLARED', status: 'ACTIVE',
    });
  });

  it('keeps a statement whole when it has no labels', () => {
    expect(parseConstraint('Rule: never block the main thread')).toMatchObject({
      statement: 'Rule: never block the main thread', confidence: 'DECLARED', status: 'UNKNOWN',
    });
  });

  it('reads one trailing label as a confidence, or as a status when it can only be one', () => {
    expect(parseConstraint('x: y:INFERRED')).toMatchObject({ statement: 'x: y', confidence: 'INFERRED', status: 'UNKNOWN' });
    expect(parseConstraint('x:SUPERSEDED')).toMatchObject({ statement: 'x', confidence: 'DECLARED', status: 'SUPERSEDED' });
    // UNKNOWN is both a confidence and a status; in the confidence position it is a confidence.
    expect(parseConstraint('x:UNKNOWN')).toMatchObject({ statement: 'x', confidence: 'UNKNOWN', status: 'UNKNOWN' });
  });

  it('treats an empty confidence as the default', () => {
    expect(parseConstraint('x::ACTIVE')).toMatchObject({ statement: 'x', confidence: 'DECLARED', status: 'ACTIVE' });
  });

  it('keeps a misspelt label in the statement instead of dropping it', () => {
    expect(parseConstraint('x:DECLRED:ACTIVE')).toMatchObject({ statement: 'x:DECLRED', status: 'ACTIVE' });
  });
});

describe('parseAttempt', () => {
  it('reads the README example as before', () => {
    expect(parseAttempt('Database row lock:failed:too slow under load')).toMatchObject({
      approach: 'Database row lock', status: 'failed', failureReason: 'too slow under load',
    });
  });

  it('keeps colons inside the reason', () => {
    expect(parseAttempt('Read the config:failed:error: ENOENT: no such file').failureReason)
      .toBe('error: ENOENT: no such file');
  });

  it('keeps an escaped colon inside the approach', () => {
    expect(parseAttempt('Use cache\\:v2:abandoned:superseded by v3')).toMatchObject({
      approach: 'Use cache:v2', status: 'abandoned', failureReason: 'superseded by v3',
    });
  });

  it('reads prose that mentions a status as the approach', () => {
    expect(parseAttempt('retry: failed: twice')).toMatchObject({
      approach: 'retry: failed: twice', status: 'succeeded',
    });
  });

  it('accepts every status the schema allows', () => {
    expect(parseAttempt('a:partial').status).toBe('partial');
    expect(parseAttempt('a:unknown').status).toBe('unknown');
    expect(parseAttempt('a:failed').failureReason).toBeUndefined();
  });
});

describe('parseFailedAttempt', () => {
  it('keeps colons inside the reason', () => {
    expect(parseFailedAttempt('startFollow with roundPixels:floors the scroll: parks 9 px off')).toMatchObject({
      approach: 'startFollow with roundPixels', status: 'failed', failureReason: 'floors the scroll: parks 9 px off',
    });
  });

  it('falls back to a generic reason when none is given', () => {
    expect(parseFailedAttempt('Database row lock').failureReason).toBe('Approach failed');
  });
});

describe('parseEvidence', () => {
  it('reads type, reference and a description that keeps its colons', () => {
    const { evidence, warning } = parseEvidence('test_run:npm test:result: 549 passed');
    expect(evidence).toEqual({ type: 'test_run', reference: 'npm test', description: 'result: 549 passed', confidence: 'DECLARED' });
    expect(warning).toBeUndefined();
  });

  it('keeps URL and Windows path references whole', () => {
    expect(parseEvidence('issue:https://github.com/o/r/issues/12:the report').evidence)
      .toMatchObject({ reference: 'https://github.com/o/r/issues/12', description: 'the report' });
    expect(parseEvidence('log:C:\\logs\\run.txt').evidence).toMatchObject({ reference: 'C:\\logs\\run.txt' });
  });

  it('reads a type alone as before', () => {
    expect(parseEvidence('test_run')).toEqual({ evidence: { type: 'test_run', reference: 'unknown', confidence: 'DECLARED' } });
  });

  it('keeps the whole value, with a warning, when it does not start with a type', () => {
    const { evidence, warning } = parseEvidence('https://example.com/run/7');
    expect(evidence).toEqual({ type: 'other', reference: 'https://example.com/run/7', confidence: 'DECLARED' });
    expect(warning).toMatch(/does not start with a known type/);
  });
});

describe('strata record, end to end', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_record_fields');
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' }).trim();

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');
    fs.writeFileSync(path.join(repoDir, 'src/camera.ts'), 'export const lerp = 0.1;\n', 'utf-8');
    git('add', '-A');
    git('commit', '-q', '-m', 'Add camera');
    const service = new StrataService(repoDir);
    service.init();
    service.close();
  });

  afterAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('stores every field with its colons, as typed on the command line', () => {
    const program = new Command();
    program.exitOverride();
    registerRecordCommand(program);
    const errors: string[] = [];
    const [log, error, cwd] = [console.log, console.error, process.cwd()];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      process.chdir(repoDir);
      program.parse(['node', 'strata', 'record',
        '--intent', 'Centre the camera exactly',
        '--files', 'src/camera.ts',
        '--failed-attempt', 'roundPixels on:Phaser floors the scroll: the camera parks 9 px off',
        '--attempt', 'lerp 1:abandoned:too jerky: no smoothing at all',
        '--constraint', 'Keep roundPixels off: lerp is 0.1:DECLARED:ACTIVE',
        '--evidence', 'issue:https://github.com/o/r/issues/12:report: camera drift',
      ]);
    } finally {
      process.chdir(cwd);
      [console.log, console.error] = [log, error];
    }
    expect(errors).toEqual([]);

    const service = new StrataService(repoDir);
    try {
      const rec = service.getRecord('REC-1')!;
      expect(rec.attempts.map((a) => [a.approach, a.status, a.failureReason])).toEqual([
        ['lerp 1', 'abandoned', 'too jerky: no smoothing at all'],
        ['roundPixels on', 'failed', 'Phaser floors the scroll: the camera parks 9 px off'],
      ]);
      expect(rec.constraints[0]).toMatchObject({
        statement: 'Keep roundPixels off: lerp is 0.1', confidence: 'DECLARED', status: 'ACTIVE',
      });
      expect(rec.evidence.find((e) => e.type === 'issue')).toMatchObject({
        reference: 'https://github.com/o/r/issues/12', description: 'report: camera drift', confidence: 'DECLARED',
      });
    } finally {
      service.close();
    }
  });
});
