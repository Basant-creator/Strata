/**
 * Read the work out of a session transcript: what changed, what was checked, and what
 * somebody said about why.
 *
 * The findings in `signals.ts` answer "what went wrong". This module answers the
 * question development memory needs — what was tried, what happened to it, and what
 * replaced it — under the same rule: every item is anchored to transcript positions,
 * and nothing is read *into* the transcript.
 *
 *   - A change is a tool call that edited a file, or a shell command that wrote into
 *     the repository. The call is VERIFIED; that it changed the file is corroborated
 *     where the session later printed `git status` or `git diff`.
 *   - A check is a verification command that ran after a change. Its outcome is read
 *     from the vendor's error flag, a failure marker in its output, or a timeout/kill
 *     finding against it — never from the agent's commentary.
 *   - An attempt is the changes between two rounds of checks, with those checks. Its
 *     result is a reading of the checks (INFERRED), and "replaced" is a separate fact:
 *     a later attempt that edited the lines this one introduced. Being replaced is not
 *     failing.
 *   - A reason, constraint or consequence is a sentence somebody wrote — the task
 *     prompt or the agent — that says so explicitly. It is quoted (DECLARED) with its
 *     position. Two actions in sequence are never turned into "X because Y".
 */

import { NormalizedEvent, ParsedTranscript } from './types.js';
import { VERIFY_CMD_RE, VERIFY_FAIL_RE } from './signals.js';

export interface ChangeAction {
  /** tool_use position. */
  index: number;
  /** tool_result position, where the stream carries one. */
  resultIndex?: number;
  via: 'edit' | 'write' | 'shell';
  tool: string;
  /** Repo-relative path. */
  path: string;
  changeType: 'add' | 'modify' | 'delete';
  /** Text the action introduced, as lines. */
  added: string[];
  /** Text the action replaced, as lines (edit tools only). */
  removed: string[];
  /** Names declared in the introduced or replaced text. */
  symbols: string[];
}

export interface CheckRun {
  index: number;
  resultIndex?: number;
  command: string;
  description?: string;
  /** What makes two runs the same check: the stated purpose, else the command. */
  key: string;
  passed: boolean;
  /** Why the outcome reads as it does, in terms of what the transcript shows. */
  outcome: string;
  quote?: string;
}

export type AttemptResult = 'succeeded' | 'failed' | 'partial' | 'abandoned' | 'unknown';

export interface WorkAttempt {
  changes: ChangeAction[];
  checks: CheckRun[];
  result: AttemptResult;
  /** Position of the command that restored the attempt's files from git. */
  revertedAt?: number;
  /** Index (in `attempts`) of the later attempt that edited what this one introduced. */
  replacedBy?: number;
  /** The commit the session made after this attempt, where it made one. */
  committedIn?: string;
  files: string[];
  symbols: string[];
  firstIndex: number;
}

export interface StatedStatement {
  kind: 'reason' | 'constraint' | 'consequence';
  /** The sentence, verbatim. */
  text: string;
  index: number;
  statedBy: string;
  /** Attempt (index in `attempts`) whose first change directly followed the statement. */
  precedesAttempt?: number;
}

export interface ObservedCommit { hash: string; subject: string; index: number }
export interface ObservedStatus { index: number; files: { path: string; status: string }[] }
export interface ObservedDiff { index: number; files: string[]; added: number; removed: number }

export interface WorkReading {
  /** Absolute roots a path was resolved against: the session's cwd and the store's. */
  roots: string[];
  changes: ChangeAction[];
  checks: CheckRun[];
  /** Checks that ran before any change: the session's own baseline. */
  baselineChecks: CheckRun[];
  attempts: WorkAttempt[];
  statements: StatedStatement[];
  commits: ObservedCommit[];
  statuses: ObservedStatus[];
  diffs: ObservedDiff[];
  startedAt?: number;
  endedAt?: number;
}

export interface ReadWorkOptions {
  /** The repository the memory will be stored in. */
  repoRoot?: string;
  /** tool_use positions that a timeout or kill finding was raised against. */
  failedToolUses?: Set<number>;
}

// ------------------------------------------------------------------ paths

const slash = (p: string): string => p.replace(/\\/g, '/');

/** An absolute path in one spelling: `D:/x/y`, whether written `D:\x\y` or `/d/x/y`. */
function canonAbsolute(p: string): string | undefined {
  const s = slash(p.trim());
  const drive = /^([A-Za-z]):\/?(.*)$/.exec(s);
  if (drive) return `${drive[1]!.toUpperCase()}:/${drive[2] ?? ''}`.replace(/\/+$/, '');
  // Git Bash spells D:\x as /d/x.
  const bash = /^\/([A-Za-z])(?:\/(.*))?$/.exec(s);
  if (bash) return `${bash[1]!.toUpperCase()}:/${bash[2] ?? ''}`.replace(/\/+$/, '');
  if (s.startsWith('/')) return s.replace(/\/+$/, '');
  return undefined;
}

function normalizeSegments(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function join(dir: string, rel: string): string {
  const abs = canonAbsolute(dir);
  const drive = abs && /^[A-Z]:\//.test(abs) ? abs.slice(0, 3) : '';
  const base = abs ? abs.slice(drive.length) : slash(dir);
  const joined = normalizeSegments(`${base}/${slash(rel)}`);
  return drive ? `${drive}${joined}` : (base.startsWith('/') ? `/${joined}` : joined);
}

/**
 * A path as the repository names it, or undefined when it is outside the repository.
 *
 * Relative paths are resolved against the directory the command ran in. Absolute ones
 * must sit under one of the roots; a scratch file in /tmp is not a change to the
 * project, and a wrong path in a provenance record is worse than a missing one.
 */
export function repoRelative(raw: string, dir: string | undefined, roots: string[]): string | undefined {
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  if (!cleaned || /^\/dev\/|^\$|^~/.test(cleaned)) return undefined;
  const joined = canonAbsolute(cleaned) ?? (dir ? join(dir, cleaned) : normalizeSegments(slash(cleaned)));
  const abs = canonAbsolute(joined);
  // No root is known and the path is relative: it is already as the repository names it.
  if (!abs) return joined && !joined.startsWith('..') ? joined : undefined;
  const lower = abs.toLowerCase();
  for (const root of roots) {
    const r = root.toLowerCase();
    if (lower === r) return undefined;
    if (lower.startsWith(`${r}/`)) return abs.slice(root.length + 1);
  }
  return undefined;
}

const NOT_PROJECT = /(^|\/)(node_modules|\.git|\.strata|dist|build|coverage)(\/|$)/;
const TEMPORARY = /(^|\/)(tmp|temp)(\/|$)|^\/tmp\//i;

// ------------------------------------------------------------------ symbols

const DECLARATION_RES = [
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
  /(?:^|\s)(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
];

/** Names declared in *lines*: what a change's own text says it defines or redefines. */
export function declaredNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    for (const re of DECLARATION_RES) {
      const m = re.exec(line);
      if (m && m[1] && m[1].length > 2 && !names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}

// ------------------------------------------------------------------ shell parsing

interface ShellWrite { path: string; content: string[]; revert: boolean; all?: boolean }

/** Options git accepts before its subcommand: `git --no-pager diff`, `git -C dir status`. */
const GIT_OPTIONS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]+))*`;
const gitSubcommand = (names: string): RegExp => new RegExp(String.raw`\bgit${GIT_OPTIONS}\s+(?:${names})\b`);
const GIT_REVERT_RE = new RegExp(String.raw`^git${GIT_OPTIONS}\s+(?:checkout|restore)\b`);
const GIT_STASH_RE = new RegExp(String.raw`^git${GIT_OPTIONS}\s+stash\b(?!\s+(?:list|show|pop|apply))`);

const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g;

/**
 * Files a shell command writes inside the repository, as far as its text shows.
 *
 * Covers the forms agents use: redirection, `tee`, `sed -i`, `perl -pi`, `mv`/`cp`
 * onto a path, and `git checkout -- path` / `git restore path` as reverts. `cd` and
 * simple `name=value` assignments are followed so `cd backend && sed -i … "$f"`
 * resolves. What a script writes internally is not guessed at.
 */
export function shellWrites(command: string, startDir: string | undefined, roots: string[]): ShellWrite[] {
  const bodies: string[] = [];
  const stripped = command.replace(HEREDOC_RE, (_all, _q, _tag, body: string) => {
    bodies.push(body);
    return ' ';
  });
  const out: ShellWrite[] = [];
  const vars = new Map<string, string>();
  let dir = startDir;
  const unquote = (t: string): string => t.replace(/^["']|["']$/g, '');
  const expand = (t: string): string => t.replace(/\$\{?(\w+)\}?/g, (m, name: string) => vars.get(name) ?? m);
  const add = (target: string, revert = false): void => {
    const raw = unquote(expand(target));
    if (!raw || /[*?]/.test(raw)) return;
    const rel = repoRelative(raw, dir, roots);
    if (!rel || NOT_PROJECT.test(rel) || TEMPORARY.test(raw) || TEMPORARY.test(rel)) return;
    if (!out.some((w) => w.path === rel && w.revert === revert)) {
      out.push({ path: rel, content: revert ? [] : bodies.flatMap((b) => b.split(/\r?\n/)), revert });
    }
  };

  for (const segment of stripped.split(/&&|\|\||;|\n/)) {
    const seg = segment.trim();
    if (!seg) continue;
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(seg);
    if (cd) {
      const target = unquote(expand(cd[1]!));
      dir = canonAbsolute(target) ?? (dir ? join(dir, target) : target);
      continue;
    }
    for (const assign of seg.matchAll(/(?:^|\s)([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
      vars.set(assign[1]!, unquote(assign[2]!));
    }
    if (GIT_REVERT_RE.test(seg)) {
      const files = seg.replace(GIT_REVERT_RE, '').trim().split(/\s+/)
        .filter((t) => t && !t.startsWith('-') && t !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(t));
      if (files.includes('.')) out.push({ path: '*', content: [], revert: true, all: true });
      else if (/\s--\s|--staged|--worktree|\brestore\b/.test(seg)) for (const f of files) add(f, true);
      continue;
    }
    if (GIT_STASH_RE.test(seg)) {
      out.push({ path: '*', content: [], revert: true, all: true });
      continue;
    }
    for (const m of seg.matchAll(/(?:^|[^0-9&>])>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(m[1]!);
    const tee = /\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;|&<>]+)/.exec(seg);
    if (tee) add(tee[1]!);
    if (/\b(?:sed|perl)\s+-[A-Za-z]*i/.test(seg)) {
      const last = /("[^"]+"|'[^']+'|[^\s;|&<>]+)\s*$/.exec(seg);
      if (last && !/^['"]?s[/|#]/.test(last[1]!)) add(last[1]!);
    }
    const mv = /\b(?:mv|cp)\s+(?:-\w+\s+)*("[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|[^\s;|&<>]+)\s*$/.exec(seg);
    if (mv) add(mv[2]!);
  }
  return out;
}

/** A script that writes files: Python, Node or shell writing through its own calls. */
const SCRIPT_WRITE_RE = /\.write\(|\bopen\([^)]*['"][wa]b?\+?['"]|writeFileSync|writeFile\(|write_text\(|write_bytes\(/;
const PATH_LITERAL_RE = /['"]((?:\.{0,2}\/)?[\w.-]+(?:[/\\][\w.-]+)*\.[A-Za-z0-9]{1,8})['"]/g;

/**
 * Repository paths an inline script names while calling a file-write function.
 *
 * Candidates only. A script can read one file and write another, and nothing in its
 * text says which literal it wrote, so `readWork` keeps a candidate only when the
 * session's own `git status` or `git diff` later shows that file changed.
 */
function scriptWriteCandidates(command: string, startDir: string | undefined, roots: string[]): string[] {
  const code: string[] = [];
  command.replace(HEREDOC_RE, (_all, _q, _tag, body: string) => { code.push(body); return ' '; });
  for (const m of command.matchAll(/\b(?:python3?|node)\s+-[ce]\s+("(?:[^"\\]|\\.)*"|'[^']*')/g)) code.push(m[1]!);
  const dir = commandDirectory(command, startDir);
  const out: string[] = [];
  for (const body of code) {
    if (!SCRIPT_WRITE_RE.test(body)) continue;
    for (const m of body.matchAll(PATH_LITERAL_RE)) {
      const rel = repoRelative(m[1]!, dir, roots);
      if (rel && !NOT_PROJECT.test(rel) && !out.includes(rel)) out.push(rel);
    }
  }
  return out;
}

/** Files a command deletes with `rm`, inside the repository. */
function removedFiles(command: string, startDir: string | undefined, roots: string[]): string[] {
  const out: string[] = [];
  let dir = startDir;
  for (const segment of command.replace(HEREDOC_RE, ' ').split(/&&|\|\||;|\n/)) {
    const seg = segment.trim();
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(seg);
    if (cd) {
      const target = cd[1]!.replace(/^["']|["']$/g, '');
      dir = canonAbsolute(target) ?? (dir ? join(dir, target) : target);
      continue;
    }
    const rm = /^rm\s+((?:-\w+\s+)*)(.+)$/.exec(seg);
    if (!rm) continue;
    for (const t of rm[2]!.split(/\s+/)) {
      const rel = repoRelative(t, dir, roots);
      if (rel && !/[*?]/.test(t)) out.push(rel);
    }
  }
  return out;
}

/** The directory a shell command ends in, from its leading `cd`s. */
function commandDirectory(command: string, startDir: string | undefined): string | undefined {
  let dir = startDir;
  for (const segment of command.replace(HEREDOC_RE, ' ').split(/&&|;|\n/)) {
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(segment);
    if (!cd) continue;
    const target = cd[1]!.replace(/^["']|["']$/g, '');
    dir = canonAbsolute(target) ?? (dir ? join(dir, target) : target);
  }
  return dir;
}

// ------------------------------------------------------------------ checks

/** A script run from a file — the usual way an agent probes the code it just changed. */
const SCRIPT_RUN_RE =
  /\b(?:node|tsx|ts-node|npx\s+(?:ts-node|tsx|vitest|jest)|python3?|deno\s+(?:run|test)|bun\s+(?:run|test))\s+(?:--?[\w-]+\s+)*[^\s-][^\s]*\.(?:[cm]?[jt]s|py)\b/;
const NPM_SCRIPT_RE = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/;
const CHECK_SCRIPT_NAME_RE = /test|lint|type|check|verif|eval|bench|build/i;
/** A stated purpose that names verification. Used only to classify, never as a result. */
const CHECK_PURPOSE_RE = /\b(verif\w*|typecheck\w*|type-check\w*|smoke|tests?|testing|lint\w*|validat\w*)\b/i;

export function isCheck(command: string, description: string | undefined): boolean {
  if (VERIFY_CMD_RE.test(command) || SCRIPT_RUN_RE.test(command)) return true;
  const npm = NPM_SCRIPT_RE.exec(command);
  if (npm && CHECK_SCRIPT_NAME_RE.test(npm[1]!)) return true;
  return !!description && CHECK_PURPOSE_RE.test(description);
}

const excerpt = (text: string | undefined, limit = 240): string | undefined => {
  const t = text?.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > limit ? `${t.slice(0, limit)}...` : t;
};

// ------------------------------------------------------------------ statements

/** Explicit causal or purposive wording. "Since" only when a clause follows it. */
const REASON_RE =
  /\b(because|so that|in order to|due to|the reason (?:is|was|being)|which would)\b|,\s*so\s+(?:I|I'll|I will|I'm|we|we'll|that|it|the|callers?|they|this)\b|\bsince\s+(?:nothing|no|none|it|this|that|there|the|we|they|I)\b/i;
/** An obligation. Code identifiers are removed first, so `Required<T>` is not one. */
const CONSTRAINT_RE =
  /\b(must(?: not)?|mustn't|has to|have to|needs? to|should not|shouldn't|(?:is|are) not allowed to|cannot be|can't be)\b/i;
/**
 * Imperatives a task prompt uses to set limits — at the start of the sentence, where an
 * instruction begins. "Never" in the middle of a description ("…and never sequenced")
 * describes behaviour; it does not set a limit.
 */
const PROMPT_CONSTRAINT_RE = /^(?:[*_]{1,2})?(do not|don't|never|must not|avoid)\b/i;
const CONSEQUENCE_RE =
  /\b(as a result|consequently|this means|which means|that means|means that|the effect (?:is|was)|leaving|leaves)\b|\bmeans\s+(?:a|an|the|any|every|it|that|callers?)\b/i;
/** A statement that repeats Strata's own memory is attributed as such. */
const CITES_MEMORY_RE = /\bREC-[\w-]+\b|\bStrata\b/;

/**
 * The sentences of some prose, whole.
 *
 * Task files and summaries wrap long sentences across lines, so lines are rejoined
 * within a paragraph first — only a blank line, a list item or a heading starts a new
 * block — and a sentence is never cut at a line break. Code blocks are not prose.
 */
function sentences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '\n\n');
  const blocks: string[] = [];
  let current = '';
  const flush = (): void => { if (current.trim()) blocks.push(current.trim()); current = ''; };
  for (const line of prose.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) { flush(); continue; }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) { flush(); current = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''); continue; }
    current = current ? `${current} ${line.trim()}` : line.trim();
  }
  flush();
  const out: string[] = [];
  for (const block of blocks) {
    for (const s of block.split(/(?<=[.!?][*_)"'\]]*)\s+(?=[A-Z`*_"(\[])/)) {
      const t = s.trim();
      if (t.length >= 20 && t.length <= 600) out.push(t);
    }
  }
  return out;
}

function classify(sentence: string, fromPrompt: boolean): StatedStatement['kind'] | undefined {
  if (/\?\s*$/.test(sentence)) return undefined;
  // Match on the prose only: inline code is a name, not a statement; emphasis is markup.
  const prose = sentence.replace(/`[^`]*`/g, 'CODE').replace(/\b[A-Za-z_$][\w$]*<[^>]*>/g, 'CODE')
    .replace(/[*_]{2}/g, '');
  if (CONSTRAINT_RE.test(prose) || (fromPrompt && PROMPT_CONSTRAINT_RE.test(prose))) return 'constraint';
  if (REASON_RE.test(prose)) return 'reason';
  if (CONSEQUENCE_RE.test(prose)) return 'consequence';
  return undefined;
}

/** Explicit statements in a task prompt supplied from outside the transcript. */
export function promptStatements(text: string): Omit<StatedStatement, 'index'>[] {
  const out: Omit<StatedStatement, 'index'>[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    const kind = classify(sentence, true);
    const norm = sentence.toLowerCase().replace(/\s+/g, ' ');
    if (!kind || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ kind, text: sentence, statedBy: 'the task prompt' });
  }
  return out;
}

// ------------------------------------------------------------------ the reading

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
const PORCELAIN_RE = /^\s*([MARCDU?!]{1,2})\s+(?:"([^"]+)"|(.+?))\s*$/;
const COMMIT_RE = /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/m;

const linesOf = (text: unknown): string[] => (typeof text === 'string' ? text.split(/\r?\n/) : []);

function timestampOf(event: NormalizedEvent): number | undefined {
  const t = (event.raw as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

export function readWork(transcript: ParsedTranscript, options: ReadWorkOptions = {}): WorkReading {
  const { events } = transcript;
  const sessionCwd = (() => {
    // Every adapter states it where its stream reports one; older parsed transcripts may not.
    if (transcript.session?.cwd) return canonAbsolute(transcript.session.cwd);
    const init = events.find((e) => e.kind === 'system' && e.subtype === 'init');
    const cwd = (init?.raw as { cwd?: unknown } | undefined)?.cwd;
    return typeof cwd === 'string' ? canonAbsolute(cwd) : undefined;
  })();
  const roots = [...new Set([sessionCwd, options.repoRoot ? canonAbsolute(options.repoRoot) : undefined]
    .filter((r): r is string => !!r))];
  const startDir = sessionCwd ?? roots[0];

  const results = new Map<string, NormalizedEvent>();
  for (const e of events) if (e.kind === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e);

  const changes: ChangeAction[] = [];
  const checks: CheckRun[] = [];
  const reverts: { index: number; path: string; all: boolean }[] = [];
  const removedLater: { index: number; path: string }[] = [];
  const scriptWrites: { index: number; resultIndex?: number; tool: string; path: string; body: string[] }[] = [];
  const commits: ObservedCommit[] = [];
  const statuses: ObservedStatus[] = [];
  const diffs: ObservedDiff[] = [];

  for (const event of events) {
    if (event.kind !== 'tool_use') continue;
    const result = event.toolUseId ? results.get(event.toolUseId) : undefined;
    const failed = result?.isError === true;
    const input = event.input ?? {};

    if (EDIT_TOOLS.test(event.name ?? '')) {
      if (failed) continue; // the vendor says the edit did not apply
      const raw = typeof input.file_path === 'string' ? input.file_path
        : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
      const path = raw ? repoRelative(raw, startDir, roots) : undefined;
      if (!path || NOT_PROJECT.test(path)) continue;
      const edits = Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [input];
      const added = edits.flatMap((e) => linesOf(e.new_string ?? e.new_source ?? e.content));
      const removed = edits.flatMap((e) => linesOf(e.old_string));
      const created = event.name === 'Write' && /File created successfully/i.test(result?.text ?? '');
      changes.push({
        index: event.index, resultIndex: result?.index,
        via: event.name === 'Write' ? 'write' : 'edit', tool: event.name ?? 'edit',
        path, changeType: created ? 'add' : 'modify', added, removed,
        symbols: declaredNames([...added, ...removed]),
      });
      continue;
    }

    if (!SHELL_TOOLS.test(event.name ?? '')) continue;
    const command = typeof input.command === 'string' ? input.command : '';
    const description = typeof input.description === 'string' ? input.description : undefined;
    if (!command) continue;
    const dir = commandDirectory(command, startDir);
    const output = result?.text ?? '';

    if (!failed) {
      for (const target of removedFiles(command, startDir, roots)) removedLater.push({ index: event.index, path: target });
      for (const target of scriptWriteCandidates(command, startDir, roots)) {
        const body: string[] = [];
        command.replace(HEREDOC_RE, (_all, _q, _tag, b: string) => { body.push(...b.split(/\r?\n/)); return ' '; });
        scriptWrites.push({ index: event.index, resultIndex: result?.index, tool: event.name ?? 'shell', path: target, body });
      }
      for (const w of shellWrites(command, startDir, roots)) {
        if (w.revert) { reverts.push({ index: event.index, path: w.path, all: !!w.all }); continue; }
        changes.push({
          index: event.index, resultIndex: result?.index, via: 'shell', tool: event.name ?? 'shell',
          path: w.path, changeType: 'modify', added: w.content, removed: [],
          symbols: declaredNames(w.content),
        });
      }
    }

    if (gitSubcommand('commit').test(command) && !failed) {
      const m = COMMIT_RE.exec(output);
      if (m) commits.push({ hash: m[2]!, subject: m[3]!.trim(), index: event.index });
    }
    if (gitSubcommand('status').test(command)) {
      const files: ObservedStatus['files'] = [];
      // --porcelain names paths from the repository root; --short from the directory it ran in.
      const base = /--porcelain/.test(command) ? startDir : dir;
      for (const line of output.split(/\r?\n/)) {
        const m = PORCELAIN_RE.exec(line);
        if (!m) continue;
        const status = m[1]!;
        if (status.includes('?') || status.includes('!')) continue;
        const rawPath = (m[2] ?? m[3] ?? '').replace(/^.* -> /, '');
        if (!/\.[A-Za-z0-9]{1,8}$/.test(rawPath)) continue;
        const rel = repoRelative(rawPath, base, roots);
        if (rel && !NOT_PROJECT.test(rel)) files.push({ path: rel, status });
      }
      if (files.length) statuses.push({ index: event.index, files });
    }
    if (gitSubcommand('diff').test(command) && /^diff --git /m.test(output)) {
      const files = [...output.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map((m) => m[2]!);
      const body = output.split(/\r?\n/);
      diffs.push({
        index: event.index,
        files: [...new Set(files)],
        added: body.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
        removed: body.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      });
    }

    // A check the permission layer refused never ran: it neither passes nor fails the work.
    if (isCheck(command, description) && !result?.denied) {
      const marker = VERIFY_FAIL_RE.exec(output);
      const killed = options.failedToolUses?.has(event.index) ?? false;
      const passed = !failed && !marker && !killed;
      checks.push({
        index: event.index, resultIndex: result?.index, command, description,
        key: (description ?? command).replace(/\s+/g, ' ').trim().toLowerCase(),
        passed,
        outcome: failed ? 'the tool reported an error'
          : killed ? 'it timed out or was killed'
          : marker ? `its output reports "${marker[1]}"`
          : 'no error or failure marker was reported',
        quote: passed ? undefined : excerpt(output),
      });
    }
  }

  /*
    An inline script's write counts only when the session's own git output later shows
    the file changed. The script's text says which paths it names; git says which one
    it wrote. Declarations are read in the target's language, so a Python helper in the
    script is not taken for a symbol of the TypeScript file it edits.
  */
  const changedLater = (path: string, after: number): boolean =>
    statuses.some((s) => s.index > after && s.files.some((f) => f.path === path))
    || diffs.some((d) => d.index > after && d.files.includes(path));
  for (const w of scriptWrites) {
    if (!changedLater(w.path, w.index)) continue;
    if (changes.some((c) => c.index === w.index && c.path === w.path)) continue;
    const python = /\.py$/.test(w.path);
    changes.push({
      index: w.index, resultIndex: w.resultIndex, via: 'shell', tool: w.tool, path: w.path,
      changeType: 'modify', added: w.body, removed: [],
      symbols: declaredNames(w.body).filter((n) => python || !w.body.some((l) => new RegExp(`^\\s*def\\s+${n}\\b`).test(l))),
    });
  }
  changes.sort((a, b) => a.index - b.index);

  /*
    A file the session wrote and then deleted is scratch — a probe script, a temporary
    harness — not a change to the project, however much it was edited in between.
  */
  const scratch = new Set(changes.filter((c) =>
    removedLater.some((r) => r.path === c.path && r.index >= c.index)).map((c) => c.path));
  for (let i = changes.length - 1; i >= 0; i--) if (scratch.has(changes[i]!.path)) changes.splice(i, 1);

  // Attempts: the changes between one round of checks and the next, with those checks.
  const attempts: WorkAttempt[] = [];
  const baselineChecks: CheckRun[] = [];
  let current: WorkAttempt | undefined;
  type Step = {
    at: number; rank: number; change?: ChangeAction; check?: CheckRun;
    revert?: (typeof reverts)[number]; commit?: ObservedCommit;
  };
  const ordered: Step[] = [
    ...changes.map((c) => ({ at: c.index, rank: 0, change: c })),
    ...checks.map((c) => ({ at: c.index, rank: 1, check: c })),
    ...reverts.map((r) => ({ at: r.index, rank: 2, revert: r })),
    ...commits.map((c) => ({ at: c.index, rank: 3, commit: c })),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank);
  // What a commit has recorded, a later `git checkout -- file` does not undo.
  const committed = new Set<WorkAttempt>();
  const commitAfter = new Map<WorkAttempt, ObservedCommit>();
  for (const step of ordered) {
    if (step.change) {
      if (current && current.checks.length) current = undefined;
      if (!current) {
        current = { changes: [], checks: [], result: 'unknown', files: [], symbols: [], firstIndex: step.at };
        attempts.push(current);
      }
      current.changes.push(step.change);
    } else if (step.check) {
      if (current) current.checks.push(step.check);
      else baselineChecks.push(step.check);
    } else if (step.revert) {
      // Restoring files from git undoes every attempt not yet undone that touched them,
      // and ends the current one: whatever comes next is a new attempt.
      const r = step.revert;
      for (const a of attempts) {
        if (a.revertedAt !== undefined || committed.has(a)) continue;
        if (r.all || a.changes.some((c) => c.path === r.path)) a.revertedAt = r.index;
      }
      if (current && current.revertedAt !== undefined) current = undefined;
    } else if (step.commit) {
      for (const a of attempts) {
        if (committed.has(a)) continue;
        committed.add(a);
        if (a.revertedAt === undefined) commitAfter.set(a, step.commit);
      }
    }
  }

  for (const a of attempts) {
    a.files = [...new Set(a.changes.map((c) => c.path))];
    a.symbols = [...new Set(a.changes.flatMap((c) => c.symbols))];
  }

  /*
    Replacement is a fact about text, not a reading of intent: a later attempt edited
    lines that this one introduced. It says nothing about whether this one worked.
  */
  const significant = (l: string): string => l.trim();
  attempts.forEach((a, i) => {
    const introduced = new Set(a.changes.flatMap((c) => c.added).map(significant).filter((l) => l.length >= 12));
    if (!introduced.size) return;
    for (let j = i + 1; j < attempts.length; j++) {
      const touches = attempts[j]!.changes.some((c) =>
        a.files.includes(c.path) && c.removed.some((l) => introduced.has(significant(l))));
      if (touches) { a.replacedBy = j; break; }
    }
  });

  /*
    An attempt reached a commit only if its own text did: one replaced before the commit
    was followed by a commit, but what that commit recorded was its replacement.
  */
  for (const [a, commit] of commitAfter) {
    const replacer = a.replacedBy !== undefined ? attempts[a.replacedBy] : undefined;
    if (!replacer || replacer.firstIndex > commit.index) a.committedIn = commit.hash;
  }

  for (const a of attempts) {
    if (a.revertedAt !== undefined) { a.result = 'abandoned'; continue; }
    if (!a.checks.length) { a.result = 'unknown'; continue; }
    // The last run of each check is its outcome; a rerun that passes supersedes a failure.
    const final = new Map<string, boolean>();
    for (const c of a.checks) final.set(c.key, c.passed);
    const outcomes = [...final.values()];
    a.result = outcomes.every(Boolean) ? 'succeeded' : outcomes.some(Boolean) ? 'partial' : 'failed';
  }

  // Statements, from the task prompt and the agent's own prose. Thinking is not read.
  const statements: StatedStatement[] = [];
  const seen = new Set<string>();
  let promptSeen = false;
  for (const event of events) {
    const fromPrompt = event.kind === 'prompt';
    if (!(fromPrompt || event.kind === 'assistant_text') || !event.text) continue;
    if (fromPrompt && promptSeen) continue;
    if (fromPrompt) promptSeen = true;
    for (const sentence of sentences(event.text)) {
      const kind = classify(sentence, fromPrompt);
      if (!kind) continue;
      const norm = sentence.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(norm)) continue;
      seen.add(norm);
      const statedBy = fromPrompt ? 'the task prompt'
        : CITES_MEMORY_RE.test(sentence) ? 'the agent, citing Strata memory' : 'the agent';
      statements.push({ kind, text: sentence, index: event.index, statedBy });
    }
  }
  // A statement is placed before the attempt whose first change came next, with no
  // check in between. That is an ordering in the transcript, and it is reported as one.
  for (const s of statements) {
    if (s.statedBy === 'the task prompt') continue;
    const next = attempts.findIndex((a) => a.firstIndex > s.index);
    if (next < 0) continue;
    const between = checks.some((c) => c.index > s.index && c.index < attempts[next]!.firstIndex);
    if (!between) s.precedesAttempt = next;
  }

  const times = events.map(timestampOf).filter((t): t is number => t !== undefined);
  return {
    roots, changes, checks, baselineChecks, attempts, statements, commits, statuses, diffs,
    ...(times.length ? { startedAt: Math.min(...times), endedAt: Math.max(...times) } : {}),
  };
}
