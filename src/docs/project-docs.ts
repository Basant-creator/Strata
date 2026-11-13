/**
 * Project docs: the store, written out as two Markdown files anyone can read.
 *
 * Why this exists
 * ---------------
 * Everything Strata knows lives in `.strata/` — JSON records and a SQLite cache — and
 * reaches an agent through a context pack. That works for an agent wired to a hook or an
 * MCP server, and for nobody else: a developer has to run a command, and an editor with
 * neither a prompt hook nor a habit of calling tools never sees any of it. A Markdown file
 * in the repository needs no integration at all. Every agent that can read a file can read
 * it, and so can every person.
 *
 *   docs/strata/DECISIONS.md  every recorded decision: what was decided, why, what failed,
 *                             the rules it set, and whether git still agrees with it.
 *   docs/strata/FLOW.md       how the project evolved, commit by commit grouped into
 *                             stages, and its shape now: modules, connections, hot spots.
 *
 * Rules the output keeps
 * ----------------------
 * * It is derived, never edited by hand: regenerate, do not patch. The header says so.
 * * Every statement keeps the provenance labels the rest of Strata uses. A record is a
 *   claim (DECLARED) and is shown as one; git facts are VERIFIED.
 * * It is deterministic: no clock time, no machine path. The same store and the same
 *   history produce the same bytes, so regenerating changes nothing unless something
 *   actually changed, and the files can be committed without noise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StrataDatabase } from '../storage/db.js';
import { StrataRepository } from '../storage/repository.js';
import { GitClient } from '../git/git.js';
import { GitCommitRecord, StrataRecord } from '../schema/types.js';
import { findContradictions, describeContradiction } from '../context/contradictions.js';

/** Where the docs go, relative to the repository root. */
export const DOCS_DIR = path.join('docs', 'strata');
export const DECISIONS_FILE = 'DECISIONS.md';
export const FLOW_FILE = 'FLOW.md';

/** The description `recordChange` gives the HEAD commit it attaches to every record it saves. */
export const HEAD_AT_RECORD = 'Current Git HEAD commit at time of record';

/** Bumped when the rendered format changes, so existing docs are regenerated once. */
export const DOCS_FORMAT = 2;

/** Commits FLOW reads. Far beyond most projects; a longer history is said to be cut. */
const MAX_FLOW_COMMITS = 5000;
/** Commit subjects listed per stage before the rest are counted. */
const SUBJECTS_PER_STAGE = 8;
const TOP = 10;

export interface DocsResult {
  /** Files written because their content changed. */
  written: string[];
  /** Files whose content was already up to date. */
  unchanged: string[];
}

interface Inputs {
  repoName: string;
  head: string | null;
  records: StrataRecord[];
  commits: GitCommitRecord[];
  commitsCut: boolean;
  files: { path: string; language: string; exported: number }[];
  edges: { from: string; to: string }[];
  dependencies: string[];
}

// ------------------------------------------------------------------ gathering

function gather(repoRoot: string, db: StrataDatabase, repo: StrataRepository): Inputs {
  const git = new GitClient(repoRoot);
  let head: string | null = null;
  try {
    head = git.getHeadHash() || null;
  } catch {
    head = null;
  }
  let commits: GitCommitRecord[] = [];
  try {
    commits = git.getCommits(MAX_FLOW_COMMITS + 1);
  } catch {
    commits = [];
  }
  const commitsCut = commits.length > MAX_FLOW_COMMITS;
  /*
    A commit that only updates these docs is not part of the project's history, and
    listing it would make the docs chase their own tail: they cannot contain the commit
    that contains them, so each one committed would be out of date the moment it landed.
    Left out, a docs-only commit changes nothing they say, so regenerating after it leaves
    the tree clean. "As of" names the newest commit they do describe. A merge, which has no
    file list here, is never mistaken for one.
  */
  const docsPrefix = `${norm(DOCS_DIR)}/`;
  const docsOnly = (c: GitCommitRecord): boolean =>
    c.changedFiles.length > 0 && c.changedFiles.every((f) => norm(f).startsWith(docsPrefix));
  commits = commits.slice(0, MAX_FLOW_COMMITS).filter((c) => !docsOnly(c))
    .sort((a, b) => a.authoredAt - b.authoredAt || a.hash.localeCompare(b.hash));
  if (commits.length) head = commits[commits.length - 1]!.hash;

  const raw = db.getRawDb();
  const files = (raw.prepare(
    `SELECT f.path AS path, f.language AS language,
            (SELECT COUNT(*) FROM code_symbols s WHERE s.file_path = f.path AND s.exported = 1) AS exported
       FROM code_files f ORDER BY f.path`,
  ).all() as { path: string; language: string; exported: number }[]);
  const edges = (raw.prepare(
    'SELECT from_file AS "from", to_file AS "to" FROM code_imports WHERE to_file IS NOT NULL ORDER BY from_file, to_file',
  ).all() as { from: string; to: string }[]);
  const dependencies = [...new Set((raw.prepare(
    `SELECT name FROM code_symbols WHERE kind = 'dependency' AND file_path = 'package.json' ORDER BY name`,
  ).all() as { name: string }[]).map((r) => r.name))];

  const records = repo.getAllRecords(100_000, 0)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  return { repoName: path.basename(repoRoot), head, records, commits, commitsCut, files, edges, dependencies };
}

// ------------------------------------------------------------------ helpers

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const short = (hash: string | null): string => (hash ? hash.slice(0, 7) : 'no commits');
const subject = (message: string): string => (message.split(/\r?\n/)[0] ?? '').trim() || '(no message)';
const norm = (p: string): string => p.replace(/\\/g, '/');
/** One line of a table cell: no pipes, no newlines. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();
/**
 * A file's module: its first two directories, so `src/webhooks/handler.ts` is in
 * `src/webhooks/` rather than everything being in `src/`; a file one level down is in its
 * directory, and a file at the top is `(root)`. A fixed rule anyone can check by eye.
 */
const moduleOf = (file: string): string => {
  const parts = norm(file).split('/');
  if (parts.length > 2) return `${parts[0]}/${parts[1]}/`;
  return parts.length === 2 ? `${parts[0]}/` : '(root)';
};

function header(title: string, inputs: Inputs, what: string): string[] {
  return [
    `# ${title}`,
    '',
    `> Generated by Strata from ${what}. Do not edit by hand: it is rewritten when the project changes ` +
      '(`strata docs` regenerates it now).',
    `> As of commit \`${short(inputs.head)}\` · ${inputs.commits.length}${inputs.commitsCut ? '+' : ''} commit(s) · ` +
      `${inputs.records.length} record(s).`,
    '',
  ];
}

const LABELS = [
  '**How to read the labels:** `VERIFIED` = read from git or the files. `DECLARED` = someone wrote it down; a claim, ' +
    'not checked. `INFERRED` = Strata\'s reading. `UNKNOWN` = not established.',
  '',
];

// ------------------------------------------------------------------ DECISIONS.md

type DecisionStatus = 'CURRENT' | 'OUT OF DATE' | 'CONTRADICTED BY GIT' | 'SUPERSEDED';

interface DecisionView {
  record: StrataRecord;
  status: DecisionStatus;
  changedSince: GitCommitRecord[];
  contradictions: ReturnType<typeof findContradictions>;
}

function assess(record: StrataRecord, inputs: Inputs, repo: StrataRepository): DecisionView {
  const files = record.files.map((f) => norm(f.path));
  const changedSince = inputs.commits.filter((c) => c.authoredAt > record.createdAt
    && c.changedFiles.some((f) => files.includes(norm(f))));
  const texts = [
    record.title, record.intent,
    ...record.attempts.flatMap((a) => [a.approach, a.failureReason ?? '', a.replacedBy ?? '']),
    ...record.constraints.map((c) => c.statement),
    ...record.consequences.map((c) => c.statement),
    ...(record.reasons ?? []).map((r) => r.statement),
    record.result.summary ?? '',
  ];
  const contradictions = findContradictions(texts, files, (hash) => {
    const c = repo.getCommitByHash(hash);
    return c ? { shortHash: c.shortHash, changedFiles: c.changedFiles } : null;
  });
  const status: DecisionStatus = record.status === 'SUPERSEDED' || record.supersededBy ? 'SUPERSEDED'
    : contradictions.length ? 'CONTRADICTED BY GIT'
    : changedSince.length ? 'OUT OF DATE'
    : 'CURRENT';
  return { record, status, changedSince, contradictions };
}

export function renderDecisions(inputs: Inputs, repo: StrataRepository): string {
  const out = header(`Decisions — ${inputs.repoName}`, inputs, 'the records in `.strata/records/` and git');
  out.push(
    'Every decision recorded for this project, oldest first: what was decided, why, what was tried and failed, the ' +
      'rules it set, and whether git still agrees with it.',
    '',
    '**Status:** `CURRENT` = no commit has changed its files since it was recorded. `OUT OF DATE` = its files changed ' +
      'afterwards, so it may no longer describe the code. `CONTRADICTED BY GIT` = it credits a commit with a change git ' +
      'shows that commit did not make. `SUPERSEDED` = replaced by a later decision.',
    '',
    ...LABELS,
  );

  if (!inputs.records.length) {
    out.push('## No decisions recorded yet', '',
      'Nothing has been written down for this project. Git history is in `FLOW.md`; the reasons behind it are UNKNOWN.',
      '',
      'Record a decision with `strata record --intent "..." --files <paths>`, or derive one from a Claude Code session ' +
        'with `strata derive <transcript> --save`. This file updates itself.',
      '');
    return out.join('\n');
  }

  const views = inputs.records.map((r) => assess(r, inputs, repo));
  out.push('## Summary', '', '| # | Decision | Status | Recorded | Files |', '| :--- | :--- | :--- | :--- | :--- |');
  for (const v of views) {
    const files = v.record.files.map((f) => `\`${norm(f.path)}\``);
    out.push(`| ${v.record.id} | ${cell(v.record.title)} | ${v.status} | ${day(v.record.createdAt)} | ` +
      `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''} |`);
  }
  out.push('');

  for (const v of views) {
    const r = v.record;
    out.push(`## ${r.id}: ${r.title}`, '');
    out.push(`- **Status:** ${v.status}${r.supersededBy ? ` (by ${r.supersededBy})` : ''}`);
    out.push(`- **Recorded:** ${day(r.createdAt)} by ${r.author.name}${r.agent?.name ? `, with ${r.agent.name}` : ''}`);
    out.push(`- **Files:** ${r.files.map((f) => `\`${norm(f.path)}\``).join(', ')}`);
    out.push(`- **Decided** (${r.intentConfidence}): ${r.intent}`);
    for (const reason of r.reasons ?? []) out.push(`- **Why** (${reason.confidence}): ${reason.statement}`);
    const failed = r.attempts.filter((a) => a.status !== 'succeeded');
    const worked = r.attempts.filter((a) => a.status === 'succeeded');
    for (const a of failed) {
      out.push(`- **Tried, ${a.status}** (${a.confidence ?? 'DECLARED'}): ${a.approach}` +
        `${a.failureReason ? ` — ${a.failureReason}` : ''}${a.replacedBy ? ` — replaced by ${a.replacedBy}` : ''}`);
    }
    for (const a of worked) {
      out.push(`- **Chosen** (${a.confidence ?? 'DECLARED'}): ${a.approach}${a.replacedBy ? ` — later replaced by ${a.replacedBy}` : ''}`);
    }
    for (const c of r.constraints) out.push(`- **Rule to keep** [${c.status}] (${c.confidence}): ${c.statement}`);
    for (const c of r.consequences) out.push(`- **Consequence** (${c.confidence}): ${c.statement}`);
    out.push(`- **Result** (DECLARED): ${r.result.status}${r.result.summary ? ` — ${r.result.summary}` : ''}`);
    // The HEAD Strata attaches when a record is saved says when it was written, not what
    // the author pointed at; it is shown as such, apart from the commits the author cited.
    const commits = r.evidence.filter((e) => e.type === 'git_commit');
    const shortOf = (ref: unknown): string | undefined => repo.getCommitByHash(String(ref))?.shortHash;
    const atRecord = commits.filter((e) => e.description === HEAD_AT_RECORD).map((e) => shortOf(e.reference)).filter((h): h is string => !!h);
    const cited = commits.filter((e) => e.description !== HEAD_AT_RECORD).map((e) => shortOf(e.reference)).filter((h): h is string => !!h);
    if (cited.length) out.push(`- **Commits cited** (VERIFIED that they exist): ${[...new Set(cited)].join(', ')}`);
    if (atRecord.length) out.push(`- **Recorded at commit** (VERIFIED): ${atRecord[0]}`);
    if (v.changedSince.length) {
      out.push(`- **Changed since** (VERIFIED): ${v.changedSince.slice(0, 6).map((c) => `${c.shortHash} (${day(c.authoredAt)})`).join(', ')}` +
        `${v.changedSince.length > 6 ? ` (+${v.changedSince.length - 6} more)` : ''}`);
    }
    for (const c of v.contradictions) out.push(`- **Contradicted by git** (VERIFIED): the record ${describeContradiction(c)}.`);
    out.push('');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ FLOW.md

/**
 * Stages of the history, by calendar month, or by week for a history shorter than two
 * months. A simple rule anyone can check against `git log`, rather than a clustering
 * nobody could reproduce.
 */
function stages(commits: GitCommitRecord[]): { label: string; commits: GitCommitRecord[] }[] {
  if (!commits.length) return [];
  const span = commits[commits.length - 1]!.authoredAt - commits[0]!.authoredAt;
  const byWeek = span < 60 * 24 * 3600 * 1000;
  const key = (ms: number): string => {
    if (!byWeek) return new Date(ms).toISOString().slice(0, 7);
    const d = new Date(ms);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return `week of ${monday.toISOString().slice(0, 10)}`;
  };
  const groups = new Map<string, GitCommitRecord[]>();
  for (const c of commits) {
    const k = key(c.authoredAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, commits: list }));
}

function topCounts(values: string[], n: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

export function renderFlow(inputs: Inputs): string {
  const out = header(`Flow — how ${inputs.repoName} evolved`, inputs, 'git history, the code index and the records');
  out.push(
    'How the project got from its first commit to now, in stages, and what it looks like today. The history is ' +
      'VERIFIED from git; commit subjects are the authors\' own words (DECLARED).',
    '',
  );

  // ---- timeline
  out.push('## Timeline', '');
  if (!inputs.commits.length) {
    out.push('No commits yet: the history is empty.', '');
  } else {
    const first = inputs.commits[0]!;
    const last = inputs.commits[inputs.commits.length - 1]!;
    out.push(`- **Started:** ${day(first.authoredAt)} with \`${first.shortHash}\` "${subject(first.message)}"`);
    out.push(`- **Latest:** ${day(last.authoredAt)} with \`${last.shortHash}\` "${subject(last.message)}"`);
    out.push(`- **Commits:** ${inputs.commits.length}${inputs.commitsCut ? ` (the newest ${MAX_FLOW_COMMITS}; older history is not shown)` : ''}` +
      ' (commits that only update `docs/strata/` are left out)');
    out.push('');
    for (const stage of stages(inputs.commits)) {
      const areas = topCounts(stage.commits.flatMap((c) => [...new Set(c.changedFiles.map(moduleOf))]), 4)
        .map(([m, n]) => `\`${m}\` (${n})`);
      const decided = inputs.records.filter((r) => {
        const t = r.createdAt;
        return t >= stage.commits[0]!.authoredAt && t <= stage.commits[stage.commits.length - 1]!.authoredAt;
      });
      out.push(`### ${stage.label} — ${stage.commits.length} commit(s)`, '');
      if (areas.length) out.push(`- **Areas changed:** ${areas.join(', ')}`);
      if (decided.length) out.push(`- **Decisions recorded:** ${decided.map((r) => `${r.id} ${r.title}`).join('; ')}`);
      for (const c of stage.commits.slice(0, SUBJECTS_PER_STAGE)) {
        out.push(`- \`${c.shortHash}\` ${day(c.authoredAt)} — ${subject(c.message)}`);
      }
      if (stage.commits.length > SUBJECTS_PER_STAGE) out.push(`- … and ${stage.commits.length - SUBJECTS_PER_STAGE} more`);
      out.push('');
    }
  }

  // ---- blueprint
  out.push('## Blueprint (now)', '');
  if (!inputs.files.length) {
    out.push('The code index is empty: run `strata index` to see the project\'s structure here.', '');
    return out.join('\n');
  }
  const modules = new Map<string, { files: number; exported: number; languages: Set<string> }>();
  for (const f of inputs.files) {
    const m = moduleOf(f.path);
    if (!modules.has(m)) modules.set(m, { files: 0, exported: 0, languages: new Set() });
    const entry = modules.get(m)!;
    entry.files++;
    entry.exported += f.exported;
    entry.languages.add(f.language);
  }
  out.push('### Modules (VERIFIED from the code index)', '', '| Module | Files | Exported symbols | Kinds |', '| :--- | ---: | ---: | :--- |');
  for (const [m, e] of [...modules.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))) {
    out.push(`| \`${m}\` | ${e.files} | ${e.exported} | ${[...e.languages].sort().join(', ')} |`);
  }
  out.push('');

  const links = topCounts(inputs.edges.map((e) => `${moduleOf(e.from)} → ${moduleOf(e.to)}`)
    .filter((l) => { const [a, b] = l.split(' → '); return a !== b; }), 15);
  if (links.length) {
    out.push('### How modules connect (imports, VERIFIED)', '');
    for (const [l, n] of links) out.push(`- \`${l.replace(' → ', '` → `')}\` (${n} import(s))`);
    out.push('');
  }

  const central = topCounts(inputs.edges.map((e) => e.to), TOP);
  if (central.length) {
    out.push('### Most depended-on files (imported by the most files, VERIFIED)', '');
    for (const [f, n] of central) out.push(`- \`${f}\` — imported ${n} time(s)`);
    out.push('');
  }

  const indexed = new Set(inputs.files.map((f) => f.path));
  const churn = topCounts(inputs.commits.flatMap((c) => [...new Set(c.changedFiles.map(norm))]).filter((f) => indexed.has(f)), TOP);
  if (churn.length) {
    out.push('### Most changed files (commits that touched them, VERIFIED)', '');
    for (const [f, n] of churn) out.push(`- \`${f}\` — ${n} commit(s)`);
    out.push('');
  }

  if (inputs.dependencies.length) {
    out.push('### Packages the project depends on (`package.json`, VERIFIED)', '',
      inputs.dependencies.map((d) => `\`${d}\``).join(', '), '');
  }

  out.push('### What this view does not cover', '',
    '- Only files Strata indexes appear above: TypeScript and JavaScript (fully), and data files such as JSON and YAML ' +
      '(by path). Other languages are not analysed.',
    '- Why the project changed lives in `DECISIONS.md`, as far as anyone recorded it.', '');
  return out.join('\n');
}

// ------------------------------------------------------------------ writing

/** Whether this repository has opted into project docs (they exist already). */
export function docsPresent(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, DOCS_DIR, DECISIONS_FILE)) || fs.existsSync(path.join(repoRoot, DOCS_DIR, FLOW_FILE));
}

/**
 * Write both docs. A file is rewritten only when its content changed, so running this
 * often leaves the working tree untouched until something real moves.
 */
export function writeProjectDocs(repoRoot: string, db: StrataDatabase, repo: StrataRepository): DocsResult {
  const inputs = gather(repoRoot, db, repo);
  const dir = path.join(repoRoot, DOCS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const result: DocsResult = { written: [], unchanged: [] };
  for (const [name, text] of [[DECISIONS_FILE, renderDecisions(inputs, repo)], [FLOW_FILE, renderFlow(inputs)]] as const) {
    const file = path.join(dir, name);
    const rel = norm(path.join(DOCS_DIR, name));
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf-8'); } catch { current = null; }
    if (current === text) { result.unchanged.push(rel); continue; }
    fs.writeFileSync(file, text, 'utf-8');
    result.written.push(rel);
  }
  return result;
}
