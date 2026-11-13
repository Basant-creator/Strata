import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { buildPromptContext } from '../src/integrations/claude-hook.js';
import { GitClient } from '../src/git/git.js';

/**
 * Landing a request that names nothing.
 *
 * A request matched only by its words can tie between files, and a tie is a LOW pack about
 * several of them. Two signals now settle it. The developer's current work — uncommitted
 * changes and recent commits — breaks a tie toward the one file in it. And steering words
 * ("first", "now", "again") no longer count as matches at all.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-work-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
let svc: StrataService;

const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repo, encoding: 'utf-8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};
const commit = (message: string, date: string): void => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message], date);
};

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'core.autocrlf', 'false']);
  // Three files the word "invoice" matches equally, and one it does not match at all.
  write('src/billing/totals.ts', 'export function invoiceTotal(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n');
  write('src/email/mailer.ts', 'export function invoiceEmail(to: string): string {\n  return `Invoice for ${to}`;\n}\n');
  write('src/pdf/render.ts', 'export function invoicePdf(id: string): string {\n  return `invoice-${id}.pdf`;\n}\n');
  write('src/pdf/layout.ts', 'export function pageLayout(): string {\n  return "a4";\n}\n');
  write('src/other.ts', 'export const OTHER = 1;\n');
  write('scripts/first-run/setup.ts', 'export function setupWorkspace(): void {}\n');
  commit('Start billing', '2026-01-01T10:00:00Z');
  for (let i = 0; i < 6; i++) {
    // Older work, pushed out of the recent window by the commits after it.
    write(`notes/n${i}.ts`, `export const N${i} = ${i};\n`);
    commit(`Note ${i}`, `2026-01-0${i + 2}T10:00:00Z`);
  }
  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
}, 120_000);

afterAll(() => {
  svc?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

const ASK = 'why is the invoice wrong';
const target = (query: string, activeFiles?: string[]) => {
  const pack = svc.getContextPack(query, activeFiles ? { activeFiles } : {});
  return { files: pack.target.files, level: pack.target.confidence.level, reason: pack.target.confidence.reason, pack };
};

describe('a tie between wording matches', () => {
  it('without current work, stays a LOW tie, as before', () => {
    const t = target(ASK, []);
    expect(t.level).toBe('LOW');
    expect(t.files.sort()).toEqual(['src/billing/totals.ts', 'src/email/mailer.ts', 'src/pdf/render.ts']);
  });

  it('is settled by the one tied file in current work: alone, MEDIUM, and marked so', () => {
    const t = target(ASK, ['src/email/mailer.ts', 'src/other.ts']);
    expect([t.files, t.level]).toEqual([['src/email/mailer.ts'], 'MEDIUM']);
    expect(t.reason).toMatch(/one such file in your current work/);
    expect(svc.renderContextPack(t.pack)).toContain('Anchors: src/email/mailer.ts (lexical "why is the invoice wrong", in your current work)');
  });

  it('is not settled when two tied files are both in current work', () => {
    expect(target(ASK, ['src/email/mailer.ts', 'src/pdf/render.ts']).level).toBe('LOW');
  });

  it('current work never makes a file match: an active file the words miss changes nothing', () => {
    const t = target(ASK, ['src/other.ts']);
    expect(t.level).toBe('LOW');
    expect(t.files).not.toContain('src/other.ts');
  });

  it('a clear winner by the words stands, whatever is in current work', () => {
    const t = target('the invoice pdf is wrong', ['src/email/mailer.ts']);
    expect(t.files[0]).toBe('src/pdf/render.ts');
    expect(t.pack.target.anchors?.some((a) => a.active)).toBe(false);
  });
});

describe('steering words', () => {
  it('match nothing on their own: no target, so the hook sends nothing', () => {
    // "first" is in the path scripts/first-run/; it used to be enough to make a target.
    expect(target('do that first, then again').pack.target.resolution).toBe('none');
    const r = buildPromptContext({ prompt: 'Do the recommended first', cwd: repo }, { refresh: false });
    expect(r.decision).toBe('skipped-no-target');
  });

  it('do not stop the other words from landing', () => {
    expect(target('why does the first-run setup fail').files[0]).toBe('scripts/first-run/setup.ts');
  });
});

describe('what counts as current work', () => {
  it('uncommitted changes, new files, and the last five code commits; not Strata\'s own output', () => {
    write('src/email/mailer.ts', 'export function invoiceEmail(to: string): string {\n  return `Invoice: ${to}`;\n}\n');
    write('src/brand-new.ts', 'export const NEW = 1;\n');
    write('docs/strata/FLOW.md', '# generated\n');
    write('.strata/records/REC-1.md', 'not a code file\n');
    const work = svc.activeFiles().sort();
    expect(work).toEqual([
      'notes/n1.ts', 'notes/n2.ts', 'notes/n3.ts', 'notes/n4.ts', 'notes/n5.ts',
      'src/brand-new.ts', 'src/email/mailer.ts',
    ]);
  });

  it('a commit of generated docs alone does not use up the window', () => {
    write('docs/strata/DECISIONS.md', '# generated\n');
    git(['add', 'docs/strata']);
    git(['commit', '-q', '-m', 'Refresh Strata docs'], '2026-02-01T10:00:00Z');
    expect(svc.activeFiles()).toContain('notes/n1.ts');
  });

  it('reads an unstaged change\'s path whole (the old reader dropped its first letter)', () => {
    expect(new GitClient(repo).getWorkingTreeChangedFiles()).toContain('src/email/mailer.ts');
  });

  it('the hook lands on the file being changed, and can be told not to', () => {
    const on = buildPromptContext({ prompt: 'Why is the invoice wrong?', cwd: repo }, { refresh: false });
    expect([on.decision, on.targets, on.confidence]).toEqual(['delivered', ['src/email/mailer.ts'], 'MEDIUM']);
    const off = buildPromptContext({ prompt: 'Why is the invoice wrong?', cwd: repo }, { refresh: false, currentWork: false });
    expect(off.confidence).toBe('LOW');
  });
});
