import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { buildPromptContext } from '../src/integrations/claude-hook.js';

/**
 * Known limits of v0.1.0, reproduced.
 *
 * Measured in Strata's own sessions, 2026-11-11 to 2026-11-13: prompts that ask nothing
 * about a file still got a pack of about 9.9k characters about one, and one history question
 * resolved to the wrong files. Each case here is the exact prompt on a small repository with
 * the same file names. What happens now is asserted plainly. What should happen is written
 * as `it.fails`: it passes while the limit stands, and fails on the day a change removes the
 * limit, which is the day to turn it into an ordinary test.
 *
 * Why these were not fixed in v0.1.0:
 * - A status question and a coding task about the status command reach the resolver in the
 *   same shape, so nothing short of a list of topic words separates them.
 * - "Commit docs" is a workflow verb before a bare noun, the same shape as "commit cache"
 *   and "push notifications", which must stay whole (REC-14).
 * - A value that exists only as a string in the code is not in the symbol index, and
 *   finding it would need a search of file contents the resolver does not have.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-limits-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
const git = (args: string[], date: string): string => execFileSync('git', args, {
  cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
});
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};
const ask = (prompt: string) => buildPromptContext({ prompt, cwd: repo });

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  const at = '2026-01-01T10:00:00Z';
  git(['init', '-q'], at);
  git(['config', 'user.email', 'fixture@example.com'], at);
  git(['config', 'user.name', 'Fixture'], at);
  git(['config', 'core.autocrlf', 'false'], at);
  write('src/cli/commands/status.ts', 'export function registerStatusCommand(): string {\n  return \'initialized\';\n}\n');
  write('src/cli/commands/record.ts', 'export function registerRecordCommand(): string {\n  return \'saved\';\n}\n');
  write('src/cli/index.ts', 'import { registerStatusCommand } from \'./commands/status.js\';\nimport { registerRecordCommand } from \'./commands/record.js\';\n\nexport const commands = [registerStatusCommand(), registerRecordCommand()];\n');
  write('src/history/changes.ts', 'export function commitChanges(commit: string): string[] {\n  return [commit];\n}\n');
  write('src/docs/project-docs.ts', 'export function renderDocs(): string {\n  return \'docs\';\n}\n');
  // The value the history question names is a string here, never a declared name.
  write('src/code/graph.ts', [
    'export type Resolution = \'lexical\' | \'target_not_found\';',
    '',
    'export function describeMissing(ids: string[]): string {',
    '  return `named a record the store does not hold: ${ids.join(\', \')}`;',
    '}',
    '',
    'export function resolve(id: string, held: string[]): Resolution {',
    '  return held.includes(id) ? \'lexical\' : \'target_not_found\';',
    '}',
    '',
  ].join('\n'));
  git(['add', '-A'], at);
  git(['commit', '-q', '-m', 'commands, history and the resolver'], at);
  write('src/code/graph.ts', fs.readFileSync(path.join(repo, 'src/code/graph.ts'), 'utf-8')
    .replace('export function resolve', '// An unknown record id is named and missing: TARGET_NOT_FOUND.\nexport function resolve'));
  git(['add', '-A'], '2026-01-02T10:00:00Z');
  git(['commit', '-q', '-m', 'Say the store has no such record when a request names an unknown id'], '2026-01-02T10:00:00Z');
  const svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
  svc.close();
}, 120_000);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('a status question gets a pack about the status command', () => {
  const QUESTION = "What's the current status of Strata now?";
  const TASK = 'Fix the status command';

  it('the question and a coding task resolve the same way: file name, MEDIUM, status.ts', () => {
    const q = ask(QUESTION);
    const t = ask(TASK);
    for (const r of [q, t]) {
      expect([r.decision, r.resolution, r.confidence]).toEqual(['delivered', 'embedded_name', 'MEDIUM']);
      expect(r.targets![0]).toBe('src/cli/commands/status.ts');
    }
  });

  it.fails('should give the question no pack about source files (limit: it does)', () => {
    expect(ask(QUESTION).decision).not.toBe('delivered');
  });

  it('the coding task keeps its pack', () => {
    expect(ask(TASK).output!.hookSpecificOutput.additionalContext).toContain('src/cli/commands/status.ts');
  });
});

describe('a commit request with a bare noun gets a pack from its words', () => {
  it('"Commit docs" is delivered whole, matched on its words', () => {
    for (const prompt of ['Commit docs', 'Commit docs and push']) {
      const r = ask(prompt);
      expect([prompt, r.decision, r.query, r.resolution]).toEqual([prompt, 'delivered', 'Commit docs', 'lexical']);
    }
  });

  it.fails('should give "Commit docs" no pack (limit: it does)', () => {
    expect(ask('Commit docs').decision).not.toBe('delivered');
  });

  it('the same shape as a noun phrase must stay whole, which is why the verb is not cut', () => {
    for (const prompt of ['commit cache misses commits', 'push notifications fail']) {
      expect(ask(prompt).query, prompt).toBe(prompt);
    }
  });

  it('a commit step with nothing else is still skipped', () => {
    for (const prompt of ['commit and push', 'Commit it', 'commit the changes']) {
      expect([prompt, ask(prompt).decision]).toEqual([prompt, 'skipped-conversational']);
    }
  });
});

describe('a history question naming a value that is only a string resolves by a plain word', () => {
  const QUESTION = 'why does an unknown record id give TARGET_NOT_FOUND?';

  it('resolves to the file named by the word "record", not to the file that holds the value', () => {
    const r = ask(QUESTION);
    expect([r.decision, r.query, r.resolution, r.confidence]).toEqual(['delivered', QUESTION, 'embedded_name', 'MEDIUM']);
    expect(r.targets![0]).toBe('src/cli/commands/record.ts');
    expect(r.targets).not.toContain('src/code/graph.ts');
  });

  it.fails('should reach the file that holds the value (limit: it does not)', () => {
    expect(ask(QUESTION).targets).toContain('src/code/graph.ts');
  });

  it('the same question naming a declared function reaches that file, HIGH', () => {
    const r = ask('why does describeMissing say the store has no record?');
    expect([r.resolution, r.confidence, r.targets]).toEqual(['embedded_symbol', 'HIGH', ['src/code/graph.ts']]);
  });
});
