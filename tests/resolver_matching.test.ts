import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { matchesWord } from '../src/code/graph.js';
import { discoverSourceFiles, analyzeFile } from '../src/code/indexer.js';
import { StrataService } from '../src/records/service.js';

/**
 * Resolver matching, and the two defects that motivated it.
 *
 * Both were found by running real queries against a real repository rather than by
 * reading the code, and both looked like ranking problems until they were instrumented:
 *
 *   1. Substring matching. "one" — from "why one is not routed" — matches
 *      "comp**one**nts", so every file importing `@/components/...` scored, repeatedly,
 *      and buried the engine files the query was about.
 *   2. Index coverage. "dataset" and "schema" matched nothing whatsoever, because the
 *      only files carrying those words are `.json` and `.prisma`, and the index held
 *      TypeScript alone.
 */
describe('resolver: whole-word matching', () => {
  it('does not match a term sitting inside a longer word', () => {
    // The exact pair that broke the flagship query.
    expect(matchesWord('@/components/CTASection', 'one')).toBe(false);
    expect(matchesWord('frontend/src/utils/decodeHtml.ts', 'code')).toBe(false);
    expect(matchesWord('AudioPreviewModal.tsx', 'one')).toBe(false);
  });

  it('matches a whole word wherever it sits in a path or identifier', () => {
    expect(matchesWord('backend/src/utils/frameAlgorithm.ts', 'frame')).toBe(true);
    expect(matchesWord('processFrameEngine', 'engine')).toBe(true);
    expect(matchesWord('backend/scripts/evaluateFrameEngine.ts', 'evaluate')).toBe(true);
  });

  it('splits camelCase so an inner word is still a word', () => {
    expect(matchesWord('getOrAnalyzeTracksBatch', 'analyze')).toBe(true);
    expect(matchesWord('oauth2Client', 'oauth')).toBe(true);
  });

  it('allows prefix agreement between two real words, in either direction', () => {
    expect(matchesWord('aliases', 'alias')).toBe(true);
    expect(matchesWord('alias', 'aliases')).toBe(true);
    // Prefix agreement is deliberate and needs both sides to be at least four
    // characters, so a four-letter stem like "comp" is allowed to reach "components".
    expect(matchesWord('components', 'comp')).toBe(true);
    // Below that the rule is exact match only, which is what kills the original bug:
    // "one" is three characters and must never reach "components".
    expect(matchesWord('components', 'one')).toBe(false);
    expect(matchesWord('components', 'ent')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesWord('FrameAlgorithm.ts', 'frame')).toBe(true);
    expect(matchesWord('frameAlgorithm.ts', 'FRAME')).toBe(false); // terms arrive lowercased
  });
});

describe('index coverage: data files', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_dataidx');

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, 'scripts', 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'scripts', 'fixtures', 'mtg_jamendo_dataset.json'),
      '[{"id":"a","bpm":120}]\n');
    fs.writeFileSync(path.join(repoDir, 'prisma', 'schema.prisma'), 'model Track { id String @id }\n');
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(repoDir, 'scripts', 'run.ts'), 'export const run = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'f@e.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'F'], { cwd: repoDir });
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
  });

  afterAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('registers data files so a query can name them', () => {
    const files = discoverSourceFiles(repoDir);
    expect(files).toContain('scripts/fixtures/mtg_jamendo_dataset.json');
    expect(files).toContain('prisma/schema.prisma');
  });

  it('excludes lockfiles, which name every package and match almost any term', () => {
    expect(discoverSourceFiles(repoDir)).not.toContain('package-lock.json');
  });

  it('registers a data file without parsing it or inventing relationships', () => {
    const a = analyzeFile(repoDir, 'scripts/fixtures/mtg_jamendo_dataset.json')!;
    expect(a.language).toBe('data');
    expect(a.symbols).toEqual([]);
    expect(a.imports).toEqual([]);
    expect(a.references).toEqual([]);
  });

  it('makes a dataset query resolve to the dataset file', () => {
    const service = new StrataService(repoDir);
    try {
      service.init();
      service.indexCode();
      const pack = service.getContextPack('dataset schema', { targetType: 'task' });
      expect(pack.target.files).toContain('scripts/fixtures/mtg_jamendo_dataset.json');
      expect(pack.target.files).toContain('prisma/schema.prisma');
    } finally {
      service.close();
    }
  });
});
