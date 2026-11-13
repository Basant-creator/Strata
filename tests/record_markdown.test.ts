import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { RecordFormatError, parseRecordMarkdown, renderRecordMarkdown } from '../src/records/markdown.js';
import { StrataRecord, StrataRecordSchema } from '../src/schema/types.js';
import { assessConfidence } from '../src/code/graph.js';

/**
 * Records as Markdown files: `.strata/records/<id>.md`.
 *
 * The file is the canonical copy a person reads, reviews and edits, and the store is
 * rebuilt from it. These tests hold it to an exact round trip, to strict reading with a
 * line number, to VERIFIED staying Strata's to give (REC-11), and to an edit by hand
 * reaching the store on the next refresh.
 */

const RICH: StrataRecord = StrataRecordSchema.parse({
  id: 'REC-7',
  title: 'Key saves on the record id, not the email',
  intent: 'Saves were keyed on the owner email.\n\n# Not a heading: a line that starts with a hash\n- not a list item\n\\ a backslash first',
  intentConfidence: 'DECLARED',
  author: { name: 'A Person', email: 'person@example.com', type: 'human' },
  agent: { name: 'Claude Code', model: 'claude-opus-5-5', provider: 'anthropic', tool: 'cli' },
  files: [
    { path: 'src/store.ts', changeType: 'modify', symbols: ['save', 'recordKey'] },
    { path: 'odd/na`me.ts', changeType: 'add' },
  ],
  attempts: [
    { sequence: 1, approach: 'Hash the email', status: 'failed', failureReason: 'two owners shared one\naddress', evidence: ['t.jsonl#12'] },
    { sequence: 2, approach: 'Key on the record id', status: 'succeeded', confidence: 'VERIFIED', replacedBy: '', evidence: [] },
  ],
  evidence: [
    { type: 'git_commit', reference: 'abc1234', description: 'Key saves on the record id', confidence: 'VERIFIED' },
    { type: 'log', reference: '`odd` ref', description: '', confidence: 'DECLARED' },
    { type: 'other', reference: 'no-description', confidence: 'INFERRED' },
  ],
  constraints: [
    { statement: 'Saves stay keyed on the record id', status: 'ACTIVE', evidence: ['abc1234'], statedBy: 'the agent' },
    { statement: 'First line\n\n- second line that looks like a list\n  indented third', status: 'SUPERSEDED', confidence: 'UNKNOWN' },
  ],
  consequences: [{ statement: 'Old email-keyed rows need a backfill', evidence: [] }],
  reasons: [{ statement: 'Emails change; ids do not', evidence: ['t.jsonl#3'], statedBy: 'the task prompt', precedesAttempt: 2 }],
  symbols: ['save', 'weird`name'],
  status: 'ACTIVE',
  supersededBy: 'REC-9',
  result: { status: 'partial', summary: 'Backfill pending.\n## not a section either' },
  createdAt: Date.parse('2026-10-01T09:30:00.123Z'),
  updatedAt: Date.parse('2026-10-02T10:00:00.456Z'),
});

describe('the Markdown form of a record', () => {
  it('reads back as the same record, every field, however the text looks', () => {
    const md = renderRecordMarkdown(RICH);
    const back = parseRecordMarkdown(md, 'REC-7.md');
    expect(back.downgraded).toEqual([]);
    expect(back.record).toEqual(RICH);
    expect(renderRecordMarkdown(back.record)).toBe(md);
  });

  it('is a document a person can read: title, sections, labelled items', () => {
    const md = renderRecordMarkdown(RICH);
    expect(md).toMatch(/^---\nid: REC-7\nschema: 0\.1\.0\nstatus: ACTIVE\nsuperseded-by: REC-9\nrecorded: 2026-10-01T09:30:00\.123Z\n/);
    expect(md).toContain('\n# Key saves on the record id, not the email\n\n## Decided\n\nSaves were keyed on the owner email.\n');
    expect(md).toContain('\n## Files\n\n- `src/store.ts` (modify)\n  - symbol: save\n  - symbol: recordKey\n- ``odd/na`me.ts`` (add)\n');
    expect(md).toContain('\n## Rules to keep\n\n- Saves stay keyed on the record id\n  - status: ACTIVE\n  - confidence: DECLARED\n  - evidence: abc1234\n  - stated by: the agent\n');
    expect(md).toContain('\n## Evidence\n\n- git_commit `abc1234` — Key saves on the record id\n  - confidence: VERIFIED\n');
    // Text that would read as structure is escaped, and only that text.
    expect(md).toContain('\n\\# Not a heading: a line that starts with a hash\n- not a list item\n\\\\ a backslash first\n');
  });

  it('trims text, which is the one normalisation', () => {
    const padded = { ...RICH, title: '  Padded title ', intent: '\n  Padded intent  \n' };
    const back = parseRecordMarkdown(renderRecordMarkdown(padded), 'REC-7.md').record;
    expect([back.title, back.intent]).toEqual(['Padded title', 'Padded intent']);
  });

  it('leaves out what a record does not have', () => {
    const bare = StrataRecordSchema.parse({
      id: 'REC-1', title: 't', intent: 'i', author: { name: 'n' },
      files: [{ path: 'a.ts', changeType: 'add' }], result: { status: 'success' }, createdAt: 0, updatedAt: 0,
    });
    const md = renderRecordMarkdown(bare);
    expect(md).not.toMatch(/## (Symbols|Evidence|Why|Tried|Rules to keep|Consequences|Result)|agent:|verified:/);
    expect(parseRecordMarkdown(md, 'REC-1.md').record).toEqual(bare);
  });
});

describe('reading is strict, and says where', () => {
  const md = renderRecordMarkdown(RICH);
  const lineOf = (needle: string): number => md.split('\n').findIndex((l) => l === needle) + 1;
  const error = (text: string): RecordFormatError => {
    try {
      parseRecordMarkdown(text, 'REC-7.md');
    } catch (err) {
      if (err instanceof RecordFormatError) return err;
      throw err;
    }
    throw new Error('expected a RecordFormatError');
  };

  it('an unknown section, label or header key is an error at its line', () => {
    expect(error(md.replace('## Tried', '## Tries')).line).toBe(lineOf('## Tried'));
    expect(error(md.replace('  - stated by: the agent', '  - said by: the agent')).message)
      .toMatch(/REC-7\.md:\d+: "said by" is not a label in "## Rules to keep"/);
    expect(error(md.replace('schema: 0.1.0', 'shema: 0.1.0')).line).toBe(lineOf('schema: 0.1.0'));
  });

  it('a heading inside a section must be escaped', () => {
    const e = error(md.replace('\\# Not a heading', '# Not a heading'));
    expect(e.line).toBe(lineOf('\\# Not a heading: a line that starts with a hash'));
  });

  it('a malformed item is an error, not a silent skip', () => {
    expect(error(md.replace('- `src/store.ts` (modify)', '- src/store.ts (modify)')).message)
      .toMatch(/a file is written "- `path` \(change\)"/);
    expect(error(md.replace('  - status: ACTIVE', '  - status: KEPT')).message).toMatch(/constraints\.0\.status/);
    expect(error(md.replace('recorded: 2026-10-01T09:30:00.123Z', 'recorded: yesterday')).message).toMatch(/"recorded" is not a date/);
    expect(error(md.replace(/\n---\n\n# /, '\n\n# ')).message).toMatch(/REC-7\.md:\d+: expected "key: value" in the header, found ""/);
    expect(error('---\nid: REC-7\n').message).toMatch(/the header is not closed/);
  });
});

describe('VERIFIED stays Strata\'s to give', () => {
  const md = renderRecordMarkdown(RICH);

  it('labels Strata wrote read back as written', () => {
    const r = parseRecordMarkdown(md, 'REC-7.md').record;
    expect(r.evidence[0]!.confidence).toBe('VERIFIED');
    expect(r.attempts[1]!.confidence).toBe('VERIFIED');
  });

  it('a VERIFIED typed by hand is read as DECLARED, and said', () => {
    const edited = md.replace('- Saves stay keyed on the record id\n  - status: ACTIVE\n  - confidence: DECLARED',
                              '- Saves stay keyed on the record id\n  - status: ACTIVE\n  - confidence: VERIFIED');
    const { record, downgraded } = parseRecordMarkdown(edited, 'REC-7.md');
    expect(record.constraints[0]!.confidence).toBe('DECLARED');
    expect(downgraded).toEqual(['rule "Saves stay keyed on the record id"']);
  });

  it('editing the text of a VERIFIED item takes its label with it; editing other text does not', () => {
    const changedItem = parseRecordMarkdown(md.replace('— Key saves on the record id', '— Key saves on the id'), 'REC-7.md');
    expect(changedItem.record.evidence[0]!.confidence).toBe('DECLARED');
    expect(changedItem.downgraded).toEqual(['evidence git_commit abc1234']);
    const changedIntent = parseRecordMarkdown(md.replace('Saves were keyed on the owner email.', 'Saves were keyed on email.'), 'REC-7.md');
    expect(changedIntent.downgraded).toEqual([]);
    expect(changedIntent.record.evidence[0]!.confidence).toBe('VERIFIED');
  });
});

// ------------------------------------------------------------------ the store and the files

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-mdrec-'));
const saved = { ...process.env };
const git = (dir: string, args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
const freshRepo = (name: string): string => {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'src/store.ts'), 'export const save = (id: string) => id;\n', 'utf-8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
};
const recordsDir = (dir: string): string => path.join(dir, '.strata', 'records');
const input = (id: string) => ({
  id, title: `Decision ${id}`, intent: 'Saves are keyed on the record id.',
  files: [{ path: 'src/store.ts', changeType: 'modify' as const }],
  constraints: [{ statement: 'Keep saves keyed on the id', status: 'ACTIVE' as const }],
  result: { status: 'success' as const },
});

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the record files and the store', () => {
  let repo: string;
  let svc: StrataService;
  beforeAll(() => {
    repo = freshRepo('sync');
    svc = new StrataService(repo);
    svc.init();
    svc.recordChange(input('REC-1'));
    // docs/strata/ present, so an edit should reach DECISIONS.md too.
    svc.writeDocs();
  }, 120_000);
  afterAll(() => svc?.close());

  it('a saved record is written as Markdown, and the HEAD Strata attached stays VERIFIED', () => {
    expect(fs.readdirSync(recordsDir(repo))).toEqual(['REC-1.md']);
    const { record, downgraded } = parseRecordMarkdown(fs.readFileSync(path.join(recordsDir(repo), 'REC-1.md'), 'utf-8'), 'REC-1.md');
    expect(downgraded).toEqual([]);
    expect(record.evidence.map((e) => e.confidence)).toEqual(['VERIFIED']);
    expect(record).toEqual(svc.getRecord('REC-1'));
  });

  it('an unchanged file changes nothing on refresh', () => {
    const stats = svc.indexCode({ trustFileTimes: true });
    expect([stats.recordsUpdated, stats.recordProblems]).toEqual([0, []]);
  });

  it('an edit by hand reaches the store and DECISIONS.md on the next refresh, once', () => {
    const file = path.join(recordsDir(repo), 'REC-1.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8')
      .replace('Saves are keyed on the record id.', 'Saves are keyed on the record id, never on email.')
      .replace('  - status: ACTIVE', '  - status: SUPERSEDED'), 'utf-8');
    const stats = svc.indexCode({ trustFileTimes: true });
    expect([stats.recordsUpdated, stats.recordProblems]).toEqual([1, []]);
    const stored = svc.getRecord('REC-1')!;
    expect(stored.intent).toBe('Saves are keyed on the record id, never on email.');
    expect(stored.constraints[0]!.status).toBe('SUPERSEDED');
    expect(fs.readFileSync(path.join(repo, 'docs/strata/DECISIONS.md'), 'utf-8')).toContain('never on email');
    expect(svc.indexCode({ trustFileTimes: true }).recordsUpdated).toBe(0);
  });

  it('a broken file is reported with its line, and the store keeps what it had', () => {
    const file = path.join(recordsDir(repo), 'REC-1.md');
    const good = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, good.replace('## Decided', '## Decision'), 'utf-8');
    const stats = svc.indexCode({ trustFileTimes: true });
    expect(stats.recordsUpdated).toBe(0);
    expect(stats.recordProblems).toEqual([{
      file: '.strata/records/REC-1.md',
      message: expect.stringMatching(/^not read: line \d+: unknown section "## Decision"/),
    }]);
    expect(svc.getRecord('REC-1')!.intent).toBe('Saves are keyed on the record id, never on email.');
    fs.writeFileSync(file, good, 'utf-8');
  });

  it('a file whose id is not its name is not read', () => {
    const stray = path.join(recordsDir(repo), 'REC-2.md');
    fs.writeFileSync(stray, fs.readFileSync(path.join(recordsDir(repo), 'REC-1.md'), 'utf-8'), 'utf-8');
    const stats = svc.indexCode({ trustFileTimes: true });
    expect(stats.recordProblems).toEqual([{ file: '.strata/records/REC-2.md', message: 'not read: the file holds REC-1, not REC-2' }]);
    expect(svc.getRecord('REC-2')).toBeNull();
    fs.unlinkSync(stray);
  });

  it('a VERIFIED typed into a file is stored as DECLARED, and reported on every refresh until fixed', () => {
    const file = path.join(recordsDir(repo), 'REC-1.md');
    const good = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, good.replace(/(- Keep saves keyed on the id\n {2}- status: SUPERSEDED\n {2}- confidence: )DECLARED/, '$1VERIFIED'), 'utf-8');
    for (let run = 0; run < 2; run++) {
      const stats = svc.indexCode({ trustFileTimes: true });
      expect(stats.recordProblems.map((p) => p.message))
        .toEqual(['rule "Keep saves keyed on the id" is marked VERIFIED, which Strata did not write; read as DECLARED']);
      expect(svc.getRecord('REC-1')!.constraints[0]!.confidence).toBe('DECLARED');
    }
    fs.writeFileSync(file, good, 'utf-8');
  });
});

describe('a record named by its id', () => {
  let repo: string;
  let svc: StrataService;
  beforeAll(() => {
    repo = freshRepo('named');
    svc = new StrataService(repo);
    svc.init();
    svc.recordChange(input('REC-1'));
    svc.recordChange(input('REC-2'));
    svc.indexCode();
  }, 120_000);
  afterAll(() => svc?.close());

  it('resolves to its record file, HIGH, and the record is in the pack about the target', () => {
    for (const ask of ['then update REC-1', 'why was rec-1 written']) {
      const pack = svc.getContextPack(ask, { detail: 'human' });
      expect([pack.target.files, pack.target.resolution, pack.target.confidence.level], ask)
        .toEqual([['.strata/records/REC-1.md'], 'named_record', 'HIGH']);
      expect(pack.target.confidence.reason).toBe('names record REC-1');
      expect(pack.memory?.find((m) => m.id === 'REC-1')?.about).toBe('target');
      // What an agent receives cites the record itself.
      expect(svc.renderContextPack(svc.getContextPack(ask))).toMatch(/\[REC-1\]/);
    }
  });

  it('sits beside a path the same request names', () => {
    expect(svc.getContextPack('compare REC-2 with src/store.ts').target.files)
      .toEqual(['src/store.ts', '.strata/records/REC-2.md']);
  });

  it('an id the store does not hold is named and missing, like a path that does not exist', () => {
    const pack = svc.getContextPack('then update REC-9');
    expect([pack.target.resolution, pack.target.files, pack.target.unresolved]).toEqual(['target_not_found', [], ['REC-9']]);
    expect(pack.target.confidence).toEqual({ level: 'NOT_FOUND', reason: 'named a record the store does not hold: REC-9' });
    expect(pack.applicability?.classification).toBe('NOT APPLICABLE');
    expect(pack.applicability?.rule).toBe('the request names a record the store does not hold, and no context was assembled');
    const text = svc.renderContextPack(pack);
    expect(text).toContain('- The store has no record REC-9.');
    expect(text).not.toMatch(/Check the path|code index does not hold/);
    // The resolver's own grade says the same, for callers that read it before the pack.
    expect(assessConfidence('target_not_found', [], ['REC-9', 'src/gone.ts']).reason)
      .toBe('named a path the index does not hold: src/gone.ts; named a record the store does not hold: REC-9');
    // A derived record's id has the same shape check.
    expect(svc.getContextPack('fix REC-T0123456789').target.confidence.level).toBe('NOT_FOUND');
  });

  it('beside a target that exists, a missing id is listed and the target still resolves', () => {
    const pack = svc.getContextPack('compare REC-9 with src/store.ts');
    expect([pack.target.files, pack.target.unresolved]).toEqual([['src/store.ts'], ['REC-9']]);
    expect(svc.renderContextPack(pack)).toContain('Named but not in the store: REC-9');
  });

  it('only the store\'s own id shape counts; other hyphenated words are left to the resolver', () => {
    for (const ask of ['fix the cross-origin header', 'see JIRA-12 for the store bug', 'why does REC-ish naming fail']) {
      expect(svc.getContextPack(ask).target.unresolved ?? [], ask).toEqual([]);
    }
  });

  it('record files never match by their words', () => {
    // Every record file's path says "records"; none of them is a wording match for it.
    expect(svc.getContextPack('why are records saved twice').target.files.filter((f) => f.startsWith('.strata/')))
      .toEqual([]);
  });
});

describe('records from before Markdown', () => {
  it('a JSON record file still loads; a Markdown file of the same id wins, and says so', () => {
    const repo = freshRepo('legacy');
    const svc = new StrataService(repo);
    try {
      svc.init();
      const old = svc.recordChange(input('REC-1'));
      // As a store written before this change would have left it.
      fs.unlinkSync(path.join(recordsDir(repo), 'REC-1.md'));
      fs.writeFileSync(path.join(recordsDir(repo), 'REC-1.json'), JSON.stringify({ ...old, title: 'From JSON' }, null, 2), 'utf-8');
      let stats = svc.indexCode({ trustFileTimes: true });
      expect([stats.recordsUpdated, stats.recordProblems]).toEqual([1, []]);
      expect(svc.getRecord('REC-1')!.title).toBe('From JSON');

      fs.writeFileSync(path.join(recordsDir(repo), 'REC-1.md'), renderRecordMarkdown({ ...old, title: 'From Markdown' }), 'utf-8');
      stats = svc.indexCode({ trustFileTimes: true });
      expect(stats.recordProblems).toEqual([{ file: '.strata/records/REC-1.json', message: 'REC-1.md holds this record; the JSON copy is ignored' }]);
      expect(svc.getRecord('REC-1')!.title).toBe('From Markdown');
    } finally {
      svc.close();
    }
  });

  it('a migrated record the store already holds is not re-saved over the store\'s own conventions', () => {
    // Files out of path order and attempts with no number, as older JSON files have them:
    // the store sorts the one and numbers the other, which is not a change to the record.
    const repo = freshRepo('conventions');
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const A = 1;\n', 'utf-8');
    const svc = new StrataService(repo);
    try {
      svc.init();
      const r = svc.recordChange({
        ...input('REC-1'),
        files: [{ path: 'src/store.ts', changeType: 'modify' }, { path: 'src/a.ts', changeType: 'add' }],
        attempts: [{ approach: 'First try', status: 'failed' }, { approach: 'Second try', status: 'succeeded' }],
      });
      fs.unlinkSync(path.join(recordsDir(repo), 'REC-1.md'));
      const asWritten = {
        ...r, files: [...r.files].sort((x, y) => y.path.localeCompare(x.path)),
        attempts: r.attempts.map(({ sequence: _s, ...a }) => a),
      };
      expect(asWritten.files.map((f) => f.path)).toEqual(['src/store.ts', 'src/a.ts']);
      fs.writeFileSync(path.join(recordsDir(repo), 'REC-1.json'), JSON.stringify(asWritten, null, 2), 'utf-8');
      expect(svc.migrateRecordFiles().migrated).toEqual(['REC-1']);
      expect(svc.indexCode({ trustFileTimes: true }).recordsUpdated).toBe(0);
      expect(svc.indexCode({ trustFileTimes: true }).recordsUpdated).toBe(0);
    } finally {
      svc.close();
    }
  });

  it('migrate-records rewrites each JSON file as Markdown, keeping every label, and removes the JSON', () => {
    const repo = freshRepo('migrate');
    const svc = new StrataService(repo);
    try {
      svc.init();
      const first = svc.recordChange(input('REC-1'));
      const second = svc.recordChange(input('REC-2'));
      for (const r of [first, second]) {
        fs.unlinkSync(path.join(recordsDir(repo), `${r.id}.md`));
        fs.writeFileSync(path.join(recordsDir(repo), `${r.id}.json`), JSON.stringify(r, null, 2), 'utf-8');
      }
      fs.writeFileSync(path.join(recordsDir(repo), 'REC-3.json'), '{ not json', 'utf-8');

      const result = svc.migrateRecordFiles();
      expect(result.migrated).toEqual(['REC-1', 'REC-2']);
      expect(result.problems).toEqual([{ file: '.strata/records/REC-3.json', message: expect.stringMatching(/^not migrated: /) }]);
      expect(fs.readdirSync(recordsDir(repo)).sort()).toEqual(['REC-1.md', 'REC-2.md', 'REC-3.json']);
      for (const r of [first, second]) {
        const back = parseRecordMarkdown(fs.readFileSync(path.join(recordsDir(repo), `${r.id}.md`), 'utf-8'), `${r.id}.md`);
        expect(back.downgraded).toEqual([]);
        expect(back.record).toEqual(r);
      }
      expect(svc.indexCode({ trustFileTimes: true }).recordsUpdated).toBe(0);
    } finally {
      svc.close();
    }
  });
});
