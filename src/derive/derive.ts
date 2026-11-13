/**
 * Assemble a Strata record from a session transcript.
 *
 * The contract this module keeps is narrow on purpose. A derived record may
 * state only what the transcript shows:
 *
 *   - WHY comes from the task prompt, so it is DECLARED, never VERIFIED.
 *   - Attempts come from detected findings. The *event* is verifiable, so its
 *     evidence is VERIFIED; the reading of that event as a failed approach is
 *     this module's inference, so the attempt is INFERRED.
 *   - RESULT comes from the stream's own terminal envelope. If the stream does
 *     not say, the result is `unknown` rather than an optimistic `success`.
 *
 * What it must never do is fill the gaps with a plausible narrative. The whole
 * reason to read the transcript is that the narrative is the unreliable part.
 */

import { createHash } from 'node:crypto';
import {
  Attempt,
  Consequence,
  Constraint,
  CreateRecordInput,
  Evidence,
  FileChange,
  ResultStatus,
  StatedReason,
} from '../schema/types.js';
import { DerivedFinding, LineEndingInspection, ParsedTranscript } from './types.js';
import { detectFindings, detectLineEndingInspection } from './signals.js';
import { parseClaudeCodeTranscript } from './claude-code.js';
import { parseAntigravityTranscript } from './antigravity.js';
import { promptStatements, readWork, repoRelative, StatedStatement, WorkAttempt, WorkReading } from './memory.js';

export interface DeriveOptions {
  /** Overrides the intent taken from the prompt. */
  intent?: string;
  /** Overrides the derived title. */
  title?: string;
  /** Author recorded on the derived record. */
  author?: { name: string; email?: string };
  /** Files known from outside the transcript, e.g. the harness's `git status`. */
  changedFiles?: string[];
  /** Human-readable transcript identity used in evidence references. */
  source?: string;
  /**
   * The task prompt, for streams that do not echo it back.
   *
   * A harness that invoked the agent with `-p` holds the prompt even when the
   * transcript does not. Supplying it here keeps the intent DECLARED rather than
   * UNKNOWN, which is the difference between a record that can be retrieved and
   * one that cannot.
   */
  prompt?: string;
  /** Where a supplied prompt came from, quoted as the evidence for what it states. */
  promptSource?: string;
  /**
   * The repository the record will be stored in. Paths the session wrote under its
   * own working directory or under this root become repository paths; anything else
   * is not a change to this repository and is left out.
   */
  repoRoot?: string;
}

export interface DerivationReport {
  record: CreateRecordInput;
  findings: DerivedFinding[];
  transcript: ParsedTranscript;
  /**
   * Secondary metric, reported for every session including those that never
   * looked. Separate from `findings` because `checked: false` is a verdict, not
   * a finding.
   */
  inspection: LineEndingInspection;
  /** What the session did, read out of the transcript. The record is built from it. */
  work: WorkReading;
  /** When the session ran, where the transcript carries timestamps. */
  observedAt?: number;
}

/** Findings that describe something going wrong become attempts. */
const ATTEMPT_KINDS = new Set([
  'timeout_backgrounded',
  'process_killed',
  'tool_error',
  'verification_failure',
  'line_ending_change',
  'repeated_write',
]);

function attemptStatus(finding: DerivedFinding): Attempt['status'] {
  return finding.kind === 'repeated_write' ? 'superseded' : 'failed';
}

/**
 * Files the session changed, as the repository names them.
 *
 * Every source is observable: edit-tool inputs, shell commands that wrote into the
 * repository, and any `git status` or `git diff` output the session printed. Paths
 * are resolved against the session's working directory, so an absolute path the
 * agent used becomes the path the Context Engine looks records up by; a path outside
 * the repository (a scratch file in /tmp) is not a change to it and is left out. In-
 * script writes are not guessed at — a wrong path in a provenance record is worse
 * than a missing one — and the caller can supply the authoritative list through
 * `changedFiles`.
 */
const STATUS_CHANGE: Record<string, FileChange['changeType']> = { A: 'add', D: 'delete', R: 'rename' };

function collectFiles(work: WorkReading, extra: string[] = []): FileChange[] {
  const files = new Map<string, FileChange>();
  const touch = (path: string, changeType: FileChange['changeType'], symbols: string[] = []): void => {
    const known = files.get(path);
    if (!known) {
      files.set(path, { path, changeType, ...(symbols.length ? { symbols } : {}) });
      return;
    }
    if (changeType !== 'modify' && known.changeType === 'modify') known.changeType = changeType;
    const merged = [...new Set([...(known.symbols ?? []), ...symbols])];
    if (merged.length) known.symbols = merged;
  };
  for (const c of work.changes) touch(c.path, c.changeType, c.symbols);
  for (const s of work.statuses) {
    for (const f of s.files) touch(f.path, STATUS_CHANGE[f.status.trim()[0] ?? ''] ?? 'modify');
  }
  for (const d of work.diffs) for (const f of d.files) touch(f, 'modify');
  for (const e of extra) {
    const rel = repoRelative(e, work.roots[0], work.roots);
    if (rel) touch(rel, 'modify');
  }
  // Path order, so the same transcript always yields the same record.
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Headline for a derived record.
 *
 * The title is what a reader sees first and what full-text retrieval weighs most,
 * so it names the finding rather than the derivation. "Derived from transcript"
 * as a title would be true and useless: it describes the provenance of the record
 * instead of the thing the record is for.
 */
const FINDING_HEADLINE: Record<DerivedFinding['kind'], string> = {
  timeout_backgrounded: 'a command overran its timeout and was backgrounded',
  process_killed: 'a background process had to be killed',
  line_ending_change: 'working-tree line endings were changed, invisibly to git diff',
  line_ending_inspection: 'line-ending state was inspected',
  tool_error: 'tool calls failed during the session',
  verification_failure: 'a verification command reported failures',
  permission_denied: 'tool calls were refused by the permission layer',
  repeated_write: 'a file was rewritten repeatedly',
};

const SEVERITY_RANK: Record<DerivedFinding['severity'], number> = {
  blocking: 0,
  notable: 1,
  informational: 2,
};

function deriveTitle(files: FileChange[], findings: DerivedFinding[], work: WorkReading): string {
  const subject =
    files.length === 1
      ? (files[0]!.path.split('/').pop() ?? 'session')
      : files.length > 1
        ? `${files.length} files`
        : 'session';

  const headline = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )[0];
  // The work, where the session changed something, then the most serious finding: a
  // title naming only a warning hides the change the session actually made.
  const n = work.attempts.length;
  const worked = n
    ? `${n} change attempt${n === 1 ? '' : 's'} in an agent session, last ${ATTEMPT_WORD[work.attempts[n - 1]!.result]}`
    : '';
  if (!headline) return `${subject}: ${worked || 'session transcript, no failure signals detected'}`;

  const others = findings.length - 1;
  const rest = others > 0 ? ` (+${others} other finding${others === 1 ? '' : 's'})` : '';
  return `${subject}: ${worked ? `${worked}; ` : ''}${FINDING_HEADLINE[headline.kind]}${rest}`;
}

/**
 * The task prompt, reduced to something that reads as an intent.
 *
 * Prompts carry harness scaffolding around the actual request. Taking the whole
 * thing would bury the intent; taking the first sentence loses it. The heuristic
 * here keeps the first substantive paragraph and marks the whole thing DECLARED,
 * which is what it is.
 */
function deriveIntent(rawPrompt: string | undefined): string | undefined {
  // Fenced code blocks are the most common first paragraph in a task file and
  // the least useful intent, so they go before the paragraph split rather than
  // being filtered out of it.
  const prompt = rawPrompt?.replace(/```[\s\S]*?```/g, '').trim();
  if (!prompt) return undefined;
  const paragraphs = prompt
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40 && !/^#/.test(p));
  const chosen = paragraphs[0] ?? prompt.replace(/\s+/g, ' ').trim();
  return chosen.length > 600 ? `${chosen.slice(0, 600)}...` : chosen;
}

function findingToAttempt(finding: DerivedFinding, source: string): Attempt {
  return {
    approach: finding.detail ? `${finding.summary}. ${finding.detail}` : finding.summary,
    status: attemptStatus(finding),
    failureReason: finding.quote
      ? `Transcript evidence: ${finding.quote}`
      : `Detected from transcript events ${finding.eventIndices.join(', ')}`,
    confidence: 'INFERRED',
    // The transcript position, so the attempt can be checked rather than believed.
    evidence: [`${source}#${finding.eventIndices.join(',')}`],
  };
}

function findingToEvidence(finding: DerivedFinding, source: string): Evidence {
  return {
    type: 'log',
    reference: `${source}#${finding.eventIndices.join(',')}`,
    description: `[${finding.kind}] ${finding.summary}`,
    confidence: 'VERIFIED',
  };
}

/**
 * Terminal status, taken from the stream rather than from the agent's summary.
 *
 * A session can end `success` at the transport level while leaving blocking
 * findings behind, so a blocking finding downgrades the result to `partial`.
 * That is the single most important difference between a derived record and a
 * self-reported one: the run that hung and killed a process reported success.
 */
function deriveResult(
  transcript: ParsedTranscript,
  findings: DerivedFinding[],
  work: WorkReading,
): { status: ResultStatus; summary: string } {
  const blocking = findings.filter((f) => f.severity === 'blocking');
  const reported = transcript.outcome?.status;

  let status: ResultStatus = 'unknown';
  if (reported === 'success') status = blocking.length > 0 ? 'partial' : 'success';
  else if (typeof reported === 'string' && reported.startsWith('error')) status = 'failure';

  const parts: string[] = [];
  parts.push(
    `Derived from the session transcript (${transcript.adapter}), not from the agent's own account.`,
  );
  if (reported) parts.push(`The stream reported terminal status "${reported}".`);
  if (typeof transcript.outcome?.durationSeconds === 'number') {
    parts.push(`Session duration ${Math.round(transcript.outcome.durationSeconds)}s.`);
  }
  parts.push(
    findings.length === 0
      ? 'No failure signals were detected; that means the detectors did not fire, not that the session was clean.'
      : `${findings.length} finding(s) detected, ${blocking.length} of them blocking.`,
  );
  if (blocking.length > 0) {
    parts.push(
      'Result downgraded to partial: the session completed, but the transcript shows work that did not.',
    );
  }
  // Whether the work reached the repository is a fact only a commit can establish.
  if (work.changes.length) {
    parts.push(work.commits.length
      ? `The session committed ${work.commits.map((c) => c.hash).join(', ')}.`
      : 'No commit was observed in the transcript, so whether these changes reached the repository is not established.');
  }
  return { status, summary: parts.join(' ') };
}

/** How an attempt's result reads in a title or a sentence. */
const ATTEMPT_WORD: Record<WorkAttempt['result'], string> = {
  succeeded: 'passed its checks',
  failed: 'failed its checks',
  partial: 'passed some checks and failed others',
  abandoned: 'was reverted',
  unknown: 'had no checks after it',
};

/**
 * The record's identity: the same session always yields the same id.
 *
 * Processing a transcript twice, or processing it again after it grew (a resumed or
 * re-captured session), must update one record rather than add a second. The
 * session id is the stable part; a stream without one falls back to its opening
 * events, which a longer capture of the same session shares. Prefixed `REC-` so the
 * Context Engine frames it as a record claim like any other.
 */
function derivedRecordId(transcript: ParsedTranscript): string {
  const identity = transcript.session?.id
    ?? transcript.events.slice(0, 20).map((e) => `${e.kind}:${e.name ?? ''}:${e.text ?? ''}`).join('\n');
  const digest = createHash('sha256').update(`${transcript.adapter}\n${identity}`).digest('hex');
  return `REC-T${digest.slice(0, 10)}`;
}

/** tool_use positions that a timeout or a kill was raised against. */
function failedToolUses(transcript: ParsedTranscript, findings: DerivedFinding[]): Set<number> {
  const out = new Set<number>();
  const useById = new Map(transcript.events.filter((e) => e.kind === 'tool_use' && e.toolUseId)
    .map((e) => [e.toolUseId!, e.index]));
  for (const f of findings) {
    if (f.kind === 'timeout_backgrounded') {
      const first = transcript.events[f.eventIndices[0] ?? -1];
      if (first?.kind === 'tool_use') out.add(first.index);
    }
    if (f.kind === 'process_killed') {
      const started = transcript.events[f.eventIndices[0] ?? -1];
      const useId = (started?.raw as { tool_use_id?: unknown } | undefined)?.tool_use_id;
      const index = typeof useId === 'string' ? useById.get(useId) : undefined;
      if (index !== undefined) out.add(index);
    }
  }
  return out;
}

const span = (indices: number[]): string => {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  return sorted.join(',');
};

/**
 * One change attempt as a record attempt.
 *
 * The approach says what changed, from the tool calls. What happened says what the
 * checks after it showed, quoting the output of the ones that failed. Both are this
 * module's reading of VERIFIED events, so the attempt is INFERRED; the positions let
 * a reader check every word against the transcript.
 */
function workAttemptToAttempt(
  a: WorkAttempt, sequence: number, all: WorkAttempt[], sequenceOf: (i: number) => number, source: string,
): Attempt {
  const via = [...new Set(a.changes.map((c) => (c.via === 'shell' ? 'shell command' : c.tool)))].join(', ');
  const at = span(a.changes.map((c) => c.index));
  const declares = a.symbols.length ? `; the changed text declares ${a.symbols.join(', ')}` : '';
  // Whether the change reached a commit travels with the attempt itself, so a reader of
  // one line — an agent's pack shows one line — cannot take session work for code at HEAD.
  // A replaced or reverted attempt's text did not survive the session either way, so
  // nothing is said about committing it; its replacement says what did.
  const landed = a.committedIn ? `; committed in the session as ${a.committedIn}`
    : a.revertedAt !== undefined || a.replacedBy !== undefined ? '' : '; no commit of it was observed in the session';
  const approach = `Changed ${a.files.join(', ')} (${a.changes.length} change(s) via ${via}, ` +
    `transcript event(s) ${at})${declares}${landed}`;

  const parts: string[] = [];
  if (a.checks.length) {
    const final = new Map<string, (typeof a.checks)[number]>();
    for (const c of a.checks) final.set(c.key, c);
    const finals = [...final.values()];
    const passed = finals.filter((c) => c.passed).length;
    parts.push(`${a.checks.length} check run(s) followed, ${finals.length} distinct; by the last run of each, ` +
      `${passed} passed and ${finals.length - passed} did not.`);
    for (const c of a.checks.filter((x) => !x.passed)) {
      const rerun = final.get(c.key) !== c && final.get(c.key)?.passed;
      parts.push(`Check "${c.description ?? c.command.slice(0, 120)}" at event ${c.index}: ${c.outcome}` +
        (c.quote ? ` — ${c.quote}` : '') + (rerun ? ' (a later run of the same check passed)' : '') + '.');
    }
  } else {
    parts.push('No check was run after this change, so its result is not established.');
  }
  if (a.revertedAt !== undefined) parts.push(`The change was restored from git at event ${a.revertedAt}.`);

  const replaced = a.replacedBy !== undefined ? all[a.replacedBy] : undefined;
  return {
    sequence,
    approach,
    status: a.result,
    failureReason: parts.join(' '),
    confidence: 'INFERRED',
    evidence: [`${source}#${span([...a.changes.map((c) => c.index), ...a.checks.map((c) => c.index)])}`],
    ...(replaced ? {
      replacedBy: `attempt ${sequenceOf(a.replacedBy!)}: a later change edited lines this one introduced ` +
        `(transcript event(s) ${span(replaced.changes.map((c) => c.index))})`,
    } : {}),
  };
}

function statementsOf(
  work: WorkReading, supplied: Omit<StatedStatement, 'index'>[], source: string, promptSource: string,
  sequenceOf: (i: number) => number,
): { reasons: StatedReason[]; constraints: Constraint[]; consequences: Consequence[] } {
  const reasons: StatedReason[] = [];
  const constraints: Constraint[] = [];
  const consequences: Consequence[] = [];
  const all: (Omit<StatedStatement, 'index'> & { index?: number })[] = [...supplied, ...work.statements];
  const seen = new Set<string>();
  for (const s of all) {
    const norm = s.text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(norm)) continue;
    seen.add(norm);
    // Every statement is somebody's words, so every one is DECLARED, with where it was said.
    const evidence = [s.index !== undefined ? `${source}#${s.index}` : promptSource];
    if (s.kind === 'reason') {
      reasons.push({
        statement: s.text, confidence: 'DECLARED', evidence, statedBy: s.statedBy,
        ...(s.precedesAttempt !== undefined ? { precedesAttempt: sequenceOf(s.precedesAttempt) } : {}),
      });
    } else if (s.kind === 'constraint') {
      constraints.push({ statement: s.text, confidence: 'DECLARED', evidence, status: 'UNKNOWN', statedBy: s.statedBy });
    } else {
      consequences.push({ statement: s.text, confidence: 'DECLARED', evidence, statedBy: s.statedBy });
    }
  }
  return { reasons, constraints, consequences };
}

/** Build a record from an already-parsed transcript. */
export function deriveRecordFromTranscript(
  transcript: ParsedTranscript,
  options: DeriveOptions = {},
): DerivationReport {
  const findings = detectFindings(transcript);
  const inspection = detectLineEndingInspection(transcript);
  const source = options.source ?? transcript.source;
  const work = readWork(transcript, {
    repoRoot: options.repoRoot,
    failedToolUses: failedToolUses(transcript, findings),
  });

  const files = collectFiles(work, options.changedFiles ?? []);
  if (files.length === 0) {
    // The schema requires at least one file. Naming the transcript is honest:
    // it says the session was observed and no file change was observable in it.
    files.push({ path: source, changeType: 'modify' });
  }

  /*
    Attempts, in transcript order.

    A change attempt carries the checks that followed it, so a failure *of one of those
    checks* is already its result and is not listed a second time. A failure the
    transcript shows anywhere else — a command before any change, a line-ending flip in
    a status command — stays an attempt of its own, as it always was.
  */
  const checkUses = new Set(work.attempts.flatMap((a) => a.checks.map((c) => c.index)));
  const changeUses = new Set(work.attempts.flatMap((a) => a.changes.map((c) => c.index)));
  const standalone = findings.filter((f) => ATTEMPT_KINDS.has(f.kind))
    .filter((f) => !checkUses.has(f.eventIndices[0] ?? -1)
      && !(f.kind === 'process_killed' && [...failedToolUses(transcript, [f])].some((i) => checkUses.has(i)))
      // Rewrites that are each already an attempt with its own result are not a further
      // "superseded" attempt; the rewrite count stays, as the observation it is.
      && !(f.kind === 'repeated_write' && f.eventIndices.every((i) => changeUses.has(i))));
  const ordered = [
    ...work.attempts.map((a, i) => ({ at: a.firstIndex, work: i as number | undefined, finding: undefined as DerivedFinding | undefined })),
    ...standalone.map((f) => ({ at: f.eventIndices[0] ?? 0, work: undefined as number | undefined, finding: f as DerivedFinding | undefined })),
  ].sort((a, b) => a.at - b.at);
  const sequenceOfWork = new Map<number, number>();
  ordered.forEach((o, i) => { if (o.work !== undefined) sequenceOfWork.set(o.work, i + 1); });
  const sequenceOf = (i: number): number => sequenceOfWork.get(i) ?? i + 1;
  const attempts: Attempt[] = ordered.map((o, i) => (o.work !== undefined
    ? workAttemptToAttempt(work.attempts[o.work]!, i + 1, work.attempts, sequenceOf, source)
    : { ...findingToAttempt(o.finding!, source), sequence: i + 1 }));

  const evidence: Evidence[] = findings.map((f) => findingToEvidence(f, source));
  evidence.push({
    type: 'log',
    reference: source,
    description:
      `Session transcript, ${transcript.events.length} normalised events` +
      (transcript.session?.id ? `, session ${transcript.session.id}` : '') +
      (work.startedAt !== undefined
        ? `, ${new Date(work.startedAt).toISOString()} to ${new Date(work.endedAt ?? work.startedAt).toISOString()}`
        : ', session time not in the transcript'),
    confidence: 'VERIFIED',
  });
  // Code and history links, each from something the session printed.
  for (const c of work.commits) {
    evidence.push({
      type: 'git_commit', reference: c.hash, confidence: 'VERIFIED',
      description: `Committed during the session (git output at ${source}#${c.index}): "${c.subject}"`,
    });
  }
  for (const d of work.diffs) {
    evidence.push({
      type: 'diff', reference: `${source}#${d.index}`, confidence: 'VERIFIED',
      description: `git diff printed at event ${d.index}: ${d.files.join(', ')} (+${d.added} −${d.removed} lines)`,
    });
  }
  const lastStatus = work.statuses[work.statuses.length - 1];
  if (lastStatus) {
    evidence.push({
      type: 'log', reference: `${source}#${lastStatus.index}`, confidence: 'VERIFIED',
      description: `Latest git status in the session (event ${lastStatus.index}): ` +
        lastStatus.files.map((f) => `${f.status.trim()} ${f.path}`).join(', '),
    });
  }

  const supplied = options.prompt && !transcript.prompt ? promptStatements(options.prompt) : [];
  const stated = statementsOf(work, supplied, source, options.promptSource ?? 'the supplied task prompt', sequenceOf);

  /*
    Derived consequences are observations, and are labelled as this module's
    reading of the transcript rather than as anybody's claim. Explicit consequences
    somebody stated come first, quoted and DECLARED.

    They are deliberately not causal. "A file was rewritten four times" is
    something the transcript shows; "the rewrites were caused by the earlier
    failure" is a story about it, and nothing here is entitled to tell one. Each
    carries the transcript positions it came from so a reader can check it.
  */
  const consequences: Consequence[] = [
    ...stated.consequences,
    ...findings
      .filter((f) => f.severity === 'informational')
      .map((f) => ({
        statement: f.summary,
        confidence: 'INFERRED' as const,
        evidence: [`${source}#${f.eventIndices.join(',')}`],
      })),
  ];

  const promptIntent = deriveIntent(options.prompt ?? transcript.prompt);
  const intent =
    options.intent ??
    promptIntent ??
    'UNKNOWN: the transcript did not carry a task prompt, so no intent could be established.';

  const record: CreateRecordInput = {
    id: derivedRecordId(transcript),
    title: options.title ?? deriveTitle(files, findings, work),
    intent,
    intentConfidence: options.intent || promptIntent ? 'DECLARED' : 'UNKNOWN',
    author: {
      name: options.author?.name ?? 'Strata transcript deriver',
      email: options.author?.email,
      type: 'system',
    },
    agent: transcript.session?.agent
      ? { name: transcript.session.agent, model: transcript.session.model }
      : undefined,
    files,
    attempts,
    evidence,
    constraints: stated.constraints,
    consequences,
    reasons: stated.reasons,
    symbols: [...new Set(files.flatMap((f) => f.symbols ?? []))],
    result: deriveResult(transcript, findings, work),
  };

  return {
    record, findings, transcript, inspection, work,
    ...(work.startedAt !== undefined ? { observedAt: work.startedAt } : {}),
  };
}

/** The transcript formats `deriveRecord` reads, by adapter name. */
const ADAPTERS: Record<string, (raw: string, source: string) => ParsedTranscript> = {
  'claude-code': parseClaudeCodeTranscript,
  antigravity: parseAntigravityTranscript,
};
const ADAPTER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', antigravity: 'Antigravity' };

/**
 * Which session format *raw* is, from its first lines that parse: `type` envelopes are
 * Claude Code's stream, `event` envelopes with an init, step or result payload are
 * Antigravity's. Null when neither shape appears.
 */
export function detectTranscriptFormat(raw: string): string | null {
  let seen = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
    if ('event' in envelope && ('init' in envelope || 'step_update' in envelope || 'result' in envelope)) return 'antigravity';
    if (typeof envelope.type === 'string' && ['system', 'assistant', 'user', 'result', 'tool_progress'].includes(envelope.type)) {
      return 'claude-code';
    }
    if (++seen >= 20) break;
  }
  return null;
}

/**
 * Parse a raw transcript, then derive a record from it.
 *
 * *adapter* names the format, or is `auto` to read it from the file. A file that is not the
 * format named, or holds no session events at all, is an error rather than a record of an
 * empty session: read as Claude Code's stream, an Antigravity session produced "Events: 0"
 * and a record whose only file was the transcript itself.
 */
export function deriveRecord(
  raw: string,
  adapter: string,
  source: string,
  options: DeriveOptions = {},
): DerivationReport {
  const supported = Object.keys(ADAPTERS).join(', ');
  if (adapter !== 'auto' && !ADAPTERS[adapter]) {
    throw new Error(`Unknown transcript adapter "${adapter}". Supported adapters: ${supported}, or auto.`);
  }
  const detected = detectTranscriptFormat(raw);
  const chosen = adapter === 'auto' ? detected : adapter;
  if (!chosen) {
    throw new Error(`${source} is not a session stream Strata can read (supported: ${supported}).`);
  }
  if (detected && detected !== chosen) {
    throw new Error(`${source} is ${ADAPTER_LABEL[detected]}'s session format, not ${ADAPTER_LABEL[chosen]}'s; ` +
      `use --adapter ${detected}, or leave --adapter out to detect it.`);
  }
  const transcript = ADAPTERS[chosen]!(raw, source);
  if (!transcript.events.length) {
    throw new Error(`${source} holds no ${ADAPTER_LABEL[chosen]} session events; there is nothing to derive.`);
  }
  return deriveRecordFromTranscript(transcript, options);
}
