/**
 * Detectors that read findings out of a normalised transcript.
 *
 * Design rule: a detector fires on an **observable** — text the tooling emitted,
 * an error flag, or a vendor lifecycle event — never on the agent's narration of
 * itself. Every finding carries the transcript positions that back it, so a
 * reader can check the claim against the source rather than trust the summary.
 *
 * The signals here were chosen by reading five real runs of one task. Two of
 * them are the reason this module exists:
 *
 *   - A command that overran its timeout, was backgrounded and then killed. That
 *     run cost twice the median of its siblings, and the agent's own record for
 *     it reported no failures at all.
 *   - A whole-file line-ending flip. `core.autocrlf=true` normalises on read, so
 *     `git diff` showed nothing; git's own warning line is the only trace, and it
 *     appeared fifteen events before the agent noticed it.
 */

import {
  DerivedFinding,
  InspectionEvidence,
  LineEndingInspection,
  LineEndingReference,
  NormalizedEvent,
  ParsedTranscript,
} from './types.js';

/** Trim an excerpt to something quotable without swallowing a page of output. */
function excerpt(text: string | undefined, limit = 300): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/** The shell command (or file path) a tool_use acted on, for attribution. */
function describeToolUse(event: NormalizedEvent | undefined): string {
  if (!event) return 'unknown command';
  const input = event.input ?? {};
  const command = input.command ?? input.file_path ?? input.pattern ?? input.description;
  const text = typeof command === 'string' ? command : JSON.stringify(input);
  return excerpt(text, 200) ?? event.name ?? 'unknown command';
}

function indexToolUses(events: NormalizedEvent[]): Map<string, NormalizedEvent> {
  const byId = new Map<string, NormalizedEvent>();
  for (const event of events) {
    if (event.kind === 'tool_use' && event.toolUseId) byId.set(event.toolUseId, event);
  }
  return byId;
}

/** Longest heartbeat reported against a tool call, in seconds. */
function maxHeartbeat(events: NormalizedEvent[], toolUseId: string | undefined): number | undefined {
  if (!toolUseId) return undefined;
  let max = 0;
  for (const event of events) {
    if (event.subtype !== 'tool_progress' || event.toolUseId !== toolUseId) continue;
    const elapsed = (event.raw as { elapsed_time_seconds?: unknown } | undefined)?.elapsed_time_seconds;
    if (typeof elapsed === 'number' && elapsed > max) max = elapsed;
  }
  return max || undefined;
}

/**
 * A command that overran its timeout and was moved to the background.
 *
 * Note the vendor does *not* flag this as an error — the tool result carries
 * `is_error: false`, because backgrounding is a successful fallback. An
 * error-flag detector alone misses it entirely, which is how it stayed out of
 * both the agent's record and the run metrics.
 */
const TIMEOUT_RE =
  /(?:command|it) did not complete within its (\d+)s timeout and was moved to the background(?:\s*\(ID:\s*([^)]+)\))?/i;

function detectTimeouts(
  events: NormalizedEvent[],
  toolUses: Map<string, NormalizedEvent>,
): DerivedFinding[] {
  const findings: DerivedFinding[] = [];
  for (const event of events) {
    if (event.kind !== 'tool_result' || !event.text) continue;
    const match = TIMEOUT_RE.exec(event.text);
    if (!match) continue;

    const seconds = Number(match[1]);
    const origin = event.toolUseId ? toolUses.get(event.toolUseId) : undefined;
    const elapsed = maxHeartbeat(events, event.toolUseId);
    findings.push({
      kind: 'timeout_backgrounded',
      severity: 'blocking',
      summary:
        `A command ran past its ${seconds}s timeout and was moved to the background` +
        (elapsed ? ` after at least ${elapsed}s of wall clock` : ''),
      detail: `Command: ${describeToolUse(origin)}`,
      eventIndices: origin ? [origin.index, event.index] : [event.index],
      quote: excerpt(event.text),
    });
  }
  return findings;
}

/** A background task the session had to kill. */
function detectKilledProcesses(
  events: NormalizedEvent[],
  toolUses: Map<string, NormalizedEvent>,
): DerivedFinding[] {
  // task_started ties a vendor task id back to the tool call that launched it.
  const taskOrigin = new Map<string, { toolUseId?: string; description?: string; index: number }>();
  for (const event of events) {
    if (event.subtype !== 'task_started') continue;
    const raw = event.raw as { task_id?: unknown; tool_use_id?: unknown; description?: unknown };
    if (typeof raw?.task_id !== 'string') continue;
    taskOrigin.set(raw.task_id, {
      toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      index: event.index,
    });
  }

  const findings: DerivedFinding[] = [];
  for (const event of events) {
    if (event.subtype !== 'task_updated') continue;
    const raw = event.raw as { task_id?: unknown; patch?: { status?: unknown } };
    if (raw?.patch?.status !== 'killed') continue;
    const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
    const origin = taskId ? taskOrigin.get(taskId) : undefined;
    const originTool = origin?.toolUseId ? toolUses.get(origin.toolUseId) : undefined;
    const indices = [event.index];
    if (origin) indices.unshift(origin.index);

    findings.push({
      kind: 'process_killed',
      severity: 'blocking',
      summary: 'A background process had to be killed before the session could continue',
      detail:
        `Task ${taskId ?? 'unknown'}` +
        (origin?.description ? ` ("${origin.description}")` : '') +
        (originTool ? `; command: ${describeToolUse(originTool)}` : ''),
      eventIndices: indices,
    });
  }
  return findings;
}

/**
 * A working-tree line-ending change.
 *
 * git emits this warning when the file on disk disagrees with what it will write
 * back. With `core.autocrlf=true` the diff is normalised, so this warning is the
 * only trace — `git diff` and `git diff --stat` both show an ordinary edit.
 */
const EOL_RE = /(LF will be replaced by CRLF|CRLF will be replaced by LF)[^\n]*/i;
const EOL_PATH_RE = /in the working copy of '([^']+)'/i;

function detectLineEndingChanges(events: NormalizedEvent[]): DerivedFinding[] {
  const byFile = new Map<string, { indices: number[]; quote?: string; direction: string }>();
  for (const event of events) {
    if (event.kind !== 'tool_result' || !event.text) continue;
    const match = EOL_RE.exec(event.text);
    if (!match) continue;
    const path = EOL_PATH_RE.exec(event.text)?.[1] ?? '(unnamed file)';
    const entry: { indices: number[]; quote?: string; direction: string } = byFile.get(path) ?? {
      indices: [],
      direction: match[1] ?? 'line endings changed',
      quote: excerpt(match[0], 200),
    };
    entry.indices.push(event.index);
    byFile.set(path, entry);
  }

  return [...byFile.entries()].map(([path, entry]) => ({
    kind: 'line_ending_change' as const,
    severity: 'notable' as const,
    summary: `The working-tree line endings of ${path} were changed (${entry.direction})`,
    detail:
      'git reported this as a warning, not as a diff. With core.autocrlf enabled the ' +
      'change is normalised on read, so `git diff` shows an ordinary edit and the ' +
      'line-ending change does not appear in it. To see it, compare the byte-level CR ' +
      'count of the file against its siblings in the working tree. Comparing it against ' +
      'the git blob instead will always agree, because the blob is stored normalised — ' +
      'that comparison cannot detect this and reads as a false all-clear.',
    eventIndices: entry.indices,
    quote: entry.quote,
    files: path === '(unnamed file)' ? undefined : [path],
  }));
}

// ------------------------------------------------- line-ending inspection
//
// `detectLineEndingChanges` above answers "did the file get flipped". This
// answers the separate question "did anyone look, and against what" — which is
// the one that separates the runs that caught a flip from the runs that looked
// straight at it and concluded all-clear.
//
// The bar for `checked` is an **observable inspection**: a command that reads
// carriage-return state, output that establishes it, or an observable action
// whose stated purpose was to establish it. Deliberately not evidence:
//
//   - a line-ending change appearing in the final diff,
//   - a passing build,
//   - `git diff` on its own — git's CRLF warning is output the agent *received*,
//     not a check the agent *ran*,
//   - talking about CRLF after the fact with no observable inspection.
//
// Each of those describes the world, not the agent's behaviour, and counting
// them would make the metric agree with itself by construction.

/**
 * Command text that **reads** carriage-return state.
 *
 * Reading is the whole distinction. An earlier version of this matched any
 * carriage-return token next to any file-reading tool, and scored one of the
 * archived runs as having inspected line endings when what it actually did was
 * `$c =~ s/\r//g` inside the perl script that applied its refactor. That command
 * is the *cause* of a flip, not a check for one; counting it would credit the
 * runs that broke the file with having looked.
 */
const CR_READ_RE = new RegExp(
  [
    // grep in a counting/matching mode, with a carriage-return pattern
    String.raw`\bgrep\b[^|;&]*\s-[a-zA-Z]*[cqnlL][a-zA-Z]*\s[^|;&]*(?:\\r|\$'\\r')`,
    // byte counts in a script: b.count(b'\r'), data.count("\r\n")
    String.raw`\.count\(\s*b?["']\\r`,
    // PowerShell and shell matching against a carriage return
    String.raw`(?:Select-String|-match|-cmatch)[^|;&]*\\r`,
    // explicit line-ending reporting modes
    String.raw`\bcat\s+-[Ae]\b`,
    String.raw`\bsed\s+-n\s*["']?l["']?`,
  ].join('|'),
);

/**
 * Byte and metadata dumps, which establish line endings but are not specific to
 * them. `file` and `od` settle the question when someone is asking it and mean
 * nothing when someone is not, so on their own they are never enough — they need
 * corroboration from a stated purpose or from output that names the answer.
 */
const BYTE_DUMP_RE = /\b(file|od|xxd|hexdump|Format-Hex)\b/;

/** Carriage-return tokens in any role, reading or writing. Used only for context. */
const CR_TOKEN_RE = /\\r\\n|\\r\b|\$'\\r'|\bCRLF\b|\bcarriage[- ]returns?\b|\b0d0a\b|\^M/i;

/** Commands whose whole purpose is line-ending state, with no CR token needed. */
const EOL_SPECIFIC_CMD_RE =
  /git\s+ls-files\s+[^|;&]*--eol|git\s+check-attr\s+[^|;&]*\b(text|eol)\b|\.gitattributes|\bdos2unix\s+-[a-zA-Z]*i|\bunix2dos\s+-[a-zA-Z]*i|\bcat\s+-[Ae]\b/;

/** Words that name the subject, used for stated purpose and for prose basis. */
const EOL_TERM_RE = /\bline[- ]endings?\b|\bline[- ]terminators?\b|\bCRLF\b|\bEOL\b|\bautocrlf\b/i;

/**
 * Wording that states an intent to *establish* line-ending state.
 *
 * Naming the subject is not enough. One archived run described its edit as
 * "Apply refactor preserving CRLF" — aware of line endings, and not inspecting
 * them. A stated purpose only makes an ambiguous call admissible when the stated
 * purpose was to find something out.
 */
const INSPECT_INTENT_RE =
  /\b(check|checking|verify|verifying|inspect|inspecting|survey|surveying|compare|comparing|confirm|confirming|audit|count|counting|examine|examining|look|looking|detect|determine|whether|did\s+I|have\s+I)\b/i;

/**
 * Output that establishes line-ending state.
 *
 * Narrow on purpose. `file(1)` says "with CRLF line terminators" and
 * `git ls-files --eol` prints `i/lf w/crlf`; both settle the question. git's
 * warning ("LF will be replaced by CRLF the next time Git touches it") is
 * excluded — it is the signal an agent may read past, and treating it as proof
 * of a check would score r2, which read past it, as having checked.
 */
const OUTPUT_ESTABLISHES_EOL_RE = /\bline terminators?\b|\bi\/(lf|crlf|mixed)\s+w\/(lf|crlf|mixed)\b/i;

/** References to git's stored object rather than to the working tree. */
const BLOB_REF_RE =
  /git\s+show\s+[^|;&]*:|git\s+cat-file|git\s+checkout-index|git\s+--no-textconv\s+show|['"]show['"]\s*,\s*['"]HEAD:|\bHEAD:[\w./-]+/;

/** Comparison spanning more than one working-tree file. */
const SIBLING_LOOP_RE = /\bfor\s+\w+\s+in\b|\bls\s+[^|;&]*\*|\*\.[A-Za-z0-9]{1,8}/;
const PATHISH_RE = /(?:^|[\s"'`=])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8})\b/g;

/** Prose that attributes a conclusion to one reference or the other. */
const SIBLING_BASIS_RE =
  /\bsiblings?\b|\bother\s+(?:source\s+|\.ts\s+)?files\b|\bevery\s+other\s+\S+\s+file\b|\bworking[- ]tree\s+files\b|\brest\s+of\s+the\s+(?:tree|repo|files)\b/i;
const BLOB_BASIS_RE =
  /\bcommitted\s+(?:file|version|copy)\b|\bthe\s+blob\b|\bin\s+the\s+blob\b|\bHEAD\s+version\b|\bin\s+HEAD\b|\bgit\s+blob\b|\bstored\s+(?:version|blob)\b|\bindex\s+version\b/i;

/** Shell command carried by a tool call, if it has one. */
function commandOf(event: NormalizedEvent): string {
  const command = event.input?.command;
  return typeof command === 'string' ? command : '';
}

function descriptionOf(event: NormalizedEvent): string {
  const description = event.input?.description;
  return typeof description === 'string' ? description : '';
}

/** True when the command text itself reads carriage-return state. */
function commandInspectsLineEndings(command: string): boolean {
  if (!command) return false;
  return EOL_SPECIFIC_CMD_RE.test(command) || CR_READ_RE.test(command);
}

/**
 * True when a command could settle line-ending state but does not say it is
 * trying to. Admissible only alongside a stated purpose or a settling output.
 */
function commandCouldSettleLineEndings(command: string): boolean {
  return BYTE_DUMP_RE.test(command) || CR_TOKEN_RE.test(command);
}

/** Distinct working-tree paths named in a command, excluding git-ref operands. */
function workingTreePaths(command: string): string[] {
  const paths = new Set<string>();
  for (const match of command.matchAll(PATHISH_RE)) {
    const path = match[1];
    if (!path) continue;
    // `HEAD:backend/x.ts` and friends name the blob, not the working tree. The
    // optional quote covers `git show "HEAD:backend/x.ts"`.
    const at = match.index ?? 0;
    const before = command.slice(Math.max(0, at - 24), at);
    if (/[\w^~]:["'`]?$/.test(before)) continue;
    if (path.startsWith('.git')) continue;
    paths.add(path);
  }
  return [...paths];
}

/**
 * Which reference a single inspecting call compared against.
 *
 * Returns every reference the call touches, because real calls touch both: the
 * run that got this right and two of the runs that got it wrong all issued one
 * command that read siblings *and* piped `git show` in the same line.
 */
function referencesInCall(command: string, output: string): Set<LineEndingReference> {
  const found = new Set<LineEndingReference>();
  if (BLOB_REF_RE.test(command)) found.add('git_blob');
  if (SIBLING_LOOP_RE.test(command) || workingTreePaths(command).length >= 2) {
    found.add('sibling_file');
  }
  // Two or more files reported with line-ending state is a sibling comparison
  // whatever the command looked like.
  const outputFiles = output.split(/\r?\n/).filter((line) => OUTPUT_ESTABLISHES_EOL_RE.test(line));
  if (outputFiles.length >= 2) found.add('sibling_file');
  return found;
}

/**
 * The reference an agent's stated conclusion rested on.
 *
 * Only consulted when the commands touched both references and so cannot settle
 * it alone. The last attributing statement wins: that is the conclusion, and the
 * earlier ones are the working.
 */
function basisFromProse(events: NormalizedEvent[], after: number): LineEndingReference {
  let basis: LineEndingReference = 'unknown';
  for (const event of events) {
    if (event.kind !== 'assistant_text' || event.index < after || !event.text) continue;
    if (!EOL_TERM_RE.test(event.text)) continue;
    if (SIBLING_BASIS_RE.test(event.text)) basis = 'sibling_file';
    else if (BLOB_BASIS_RE.test(event.text)) basis = 'git_blob';
  }
  return basis;
}

/**
 * Did the session inspect line-ending state, and against what?
 *
 * Always returns a verdict, including `checked: false`. Confidence qualifies the
 * verdict as a whole:
 *
 *   - VERIFIED  — a command or its output directly establishes the check.
 *   - INFERRED  — the check rests on a stated purpose, or the reference had to be
 *                 resolved from prose because the commands touched both.
 *   - UNKNOWN   — no check was found. A negative cannot be verified from a
 *                 transcript: an inspection this detector does not recognise is
 *                 indistinguishable from no inspection at all.
 */
export function detectLineEndingInspection(transcript: ParsedTranscript): LineEndingInspection {
  const events = withoutOwnMemory(transcript.events);
  const toolUses = indexToolUses(events);

  const evidence: InspectionEvidence[] = [];
  const inspectingCalls = new Map<number, { command: string; output: string }>();
  let restedOnPurposeOnly = true;

  const noteCall = (event: NormalizedEvent, basis: InspectionEvidence['basis'], quote: string) => {
    evidence.push({ index: event.index, basis, quote });
    if (basis !== 'purpose') restedOnPurposeOnly = false;
    const existing = inspectingCalls.get(event.index);
    inspectingCalls.set(event.index, {
      command: existing?.command || commandOf(event),
      output: existing?.output ?? '',
    });
  };

  for (const event of events) {
    if (event.kind !== 'tool_use') continue;
    const command = commandOf(event);

    if (commandInspectsLineEndings(command)) {
      noteCall(event, 'command', excerpt(command, 200) ?? command);
      continue;
    }

    // A stated purpose makes an otherwise ambiguous observable action
    // attributable. The action still has to be one that could read the file —
    // "check the line endings" followed by a typecheck is not an inspection.
    const stated = descriptionOf(event) || precedingIntent(events, event.index);
    if (
      stated &&
      EOL_TERM_RE.test(stated) &&
      INSPECT_INTENT_RE.test(stated) &&
      commandCouldSettleLineEndings(command)
    ) {
      noteCall(event, 'purpose', excerpt(stated, 200) ?? stated);
    }
  }

  // Outputs that settle line-ending state, attributed back to their call.
  for (const event of events) {
    if (event.kind !== 'tool_result' || !event.text) continue;
    if (!OUTPUT_ESTABLISHES_EOL_RE.test(event.text)) continue;
    const origin = event.toolUseId ? toolUses.get(event.toolUseId) : undefined;
    const anchor = origin ?? event;
    noteCall(anchor, 'output', excerpt(event.text, 200) ?? '');
    restedOnPurposeOnly = false;
    const entry = inspectingCalls.get(anchor.index);
    inspectingCalls.set(anchor.index, {
      command: entry?.command || commandOf(anchor),
      output: `${entry?.output ?? ''}\n${event.text}`,
    });
  }

  if (evidence.length === 0) {
    return { checked: false, reference: 'unknown', confidence: 'UNKNOWN', evidence: [], eventIndices: [] };
  }

  const references = new Set<LineEndingReference>();
  for (const { command, output } of inspectingCalls.values()) {
    for (const reference of referencesInCall(command, output)) references.add(reference);
  }

  let reference: LineEndingReference = 'unknown';
  let resolvedFromProse = false;
  if (references.size === 1) {
    reference = [...references][0] ?? 'unknown';
  } else if (references.size > 1) {
    const firstInspection = Math.min(...evidence.map((e) => e.index));
    reference = basisFromProse(events, firstInspection);
    resolvedFromProse = reference !== 'unknown';
  }

  const confidence = restedOnPurposeOnly || resolvedFromProse ? 'INFERRED' : 'VERIFIED';
  const eventIndices = [...new Set(evidence.map((e) => e.index))].sort((a, b) => a - b);

  return { checked: true, reference, confidence, evidence, eventIndices };
}

/** Assistant prose immediately before a call, which can state that call's purpose. */
function precedingIntent(events: NormalizedEvent[], index: number): string {
  for (let i = index - 1; i >= 0 && i >= index - 2; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === 'assistant_text' && event.text) return event.text;
  }
  return '';
}

/** Tool calls the vendor itself flagged as failed. */
function detectToolErrors(
  events: NormalizedEvent[],
  toolUses: Map<string, NormalizedEvent>,
): DerivedFinding[] {
  const findings: DerivedFinding[] = [];
  for (const event of events) {
    // A refused call did not run, so it did not fail; detectPermissionDenials reports it.
    if (event.kind !== 'tool_result' || !event.isError || event.denied) continue;
    const origin = event.toolUseId ? toolUses.get(event.toolUseId) : undefined;
    findings.push({
      kind: 'tool_error',
      severity: 'notable',
      summary: `A ${origin?.name ?? 'tool'} call failed`,
      detail: `Call: ${describeToolUse(origin)}`,
      eventIndices: origin ? [origin.index, event.index] : [event.index],
      quote: excerpt(event.text),
    });
  }
  return findings;
}

/**
 * A verification command that reported failure.
 *
 * Kept separate from `tool_error` because a typecheck or test run that exits
 * non-zero is usually reported as a *successful* tool call with failing output.
 */
export const VERIFY_CMD_RE =
  /\b(tsc|vitest|jest|pytest|npm (?:run )?(?:test|build|typecheck)|cargo (?:test|build)|go test|make (?:test|check))\b/;
export const VERIFY_FAIL_RE =
  /(error TS\d+|\bFAIL\b|\d+ failed|npm ERR!|Command failed|Traceback \(most recent call last\))/;

function detectVerificationFailures(
  events: NormalizedEvent[],
  toolUses: Map<string, NormalizedEvent>,
): DerivedFinding[] {
  const findings: DerivedFinding[] = [];
  for (const event of events) {
    if (event.kind !== 'tool_result' || !event.text || event.isError) continue;
    const origin = event.toolUseId ? toolUses.get(event.toolUseId) : undefined;
    const command = typeof origin?.input?.command === 'string' ? origin.input.command : '';
    if (!VERIFY_CMD_RE.test(command)) continue;
    if (!VERIFY_FAIL_RE.test(event.text)) continue;
    findings.push({
      kind: 'verification_failure',
      severity: 'notable',
      summary: 'A verification command reported failures',
      detail: `Command: ${excerpt(command, 200)}`,
      eventIndices: origin ? [origin.index, event.index] : [event.index],
      quote: excerpt(event.text),
    });
  }
  return findings;
}

/** Permission refusals the vendor recorded on the terminal result envelope. */
function detectPermissionDenials(events: NormalizedEvent[]): DerivedFinding[] {
  const findings: DerivedFinding[] = [];
  for (const event of events) {
    if (event.kind !== 'result') continue;
    const denials = event.denials;
    if (!denials?.length) continue;
    findings.push({
      kind: 'permission_denied',
      severity: 'informational',
      summary: `${denials.length} tool call(s) were refused by the permission layer`,
      eventIndices: [event.index],
      quote: excerpt(JSON.stringify(denials)),
    });
  }
  return findings;
}

/**
 * A file written enough times to indicate the first attempts did not hold.
 *
 * Three is the threshold: an edit plus one correction is ordinary work, and
 * flagging it would bury the findings that matter under noise.
 */
const REWRITE_THRESHOLD = 3;

function detectRepeatedWrites(events: NormalizedEvent[]): DerivedFinding[] {
  const writes = new Map<string, number[]>();
  for (const event of events) {
    if (event.kind !== 'tool_use') continue;
    if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(event.name ?? '')) continue;
    const path = event.input?.file_path;
    if (typeof path !== 'string') continue;
    writes.set(path, [...(writes.get(path) ?? []), event.index]);
  }

  return [...writes.entries()]
    .filter(([, indices]) => indices.length >= REWRITE_THRESHOLD)
    .map(([path, indices]) => ({
      kind: 'repeated_write' as const,
      severity: 'informational' as const,
      summary: `${path} was rewritten ${indices.length} times during the session`,
      eventIndices: indices,
      files: [path],
    }));
}

/**
 * The inspection verdict as a finding, when there was something to find.
 *
 * Emitted only for `checked: true`. A finding is something that demonstrably
 * happened, and "nobody looked" is an absence — recording it as a finding would
 * put a phantom line in the record's evidence with no transcript position behind
 * it. Callers that need the negative read `DerivationReport.inspection`, which is
 * always populated.
 */
function inspectionFinding(inspection: LineEndingInspection): DerivedFinding[] {
  if (!inspection.checked) return [];
  const against =
    inspection.reference === 'unknown'
      ? 'against a reference the transcript does not establish'
      : `against ${inspection.reference === 'sibling_file' ? 'sibling working-tree files' : "git's stored blob"}`;
  return [
    {
      kind: 'line_ending_inspection',
      severity: 'informational',
      summary: `The session inspected line-ending state, ${against}`,
      detail: `Determination confidence: ${inspection.confidence}. Basis: ${[
        ...new Set(inspection.evidence.map((e) => e.basis)),
      ].join(', ')}.`,
      eventIndices: inspection.eventIndices,
      quote: inspection.evidence[0]?.quote,
    },
  ];
}

/**
 * The events that show what the session did, without Strata's own memory read back.
 *
 * An agent that asks Strata for context receives earlier records as a tool result, and
 * those records describe earlier sessions — a timeout, a line-ending flip. Read as this
 * session's output, they became findings about things that never happened in it:
 * measured on real transcripts, two derived records carried a FAILED "line endings of
 * (unnamed file) were changed" taken from a record's description. Memory is not evidence
 * of the session that read it, so a Strata tool's result is not read by the detectors
 * that look at output text. A Strata call that itself errors is still a tool error.
 */
const STRATA_TOOL_RE = /strata/i;

function withoutOwnMemory(events: NormalizedEvent[]): NormalizedEvent[] {
  const toolUses = indexToolUses(events);
  return events.filter((e) => {
    if (e.kind !== 'tool_result' || !e.toolUseId) return true;
    return !STRATA_TOOL_RE.test(toolUses.get(e.toolUseId)?.name ?? '');
  });
}

/** Run every detector over a parsed transcript, in transcript order. */
export function detectFindings(transcript: ParsedTranscript): DerivedFinding[] {
  const { events } = transcript;
  const toolUses = indexToolUses(events);
  const observed = withoutOwnMemory(events);
  const findings = [
    ...detectTimeouts(observed, toolUses),
    ...detectKilledProcesses(events, toolUses),
    ...detectLineEndingChanges(observed),
    ...inspectionFinding(detectLineEndingInspection(transcript)),
    ...detectToolErrors(events, toolUses),
    ...detectVerificationFailures(observed, toolUses),
    ...detectPermissionDenials(events),
    ...detectRepeatedWrites(events),
  ];
  return findings.sort((a, b) => (a.eventIndices[0] ?? 0) - (b.eventIndices[0] ?? 0));
}
