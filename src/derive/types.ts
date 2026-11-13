/**
 * Types for deriving Strata records from an agent session transcript.
 *
 * Why this exists
 * ---------------
 * Every record in the store until now was written by the agent that did the work,
 * through `strata_record_change`. Five measured runs of the same task showed the
 * limit of that: the run that hung a process for five minutes and had to kill it
 * wrote a record reporting no failures. The omission was not dishonesty — by the
 * time the agent summarised itself, the episode no longer felt load-bearing.
 *
 * A transcript does not forget. These types normalise a vendor's session stream
 * into events, and events into findings, so the failure record is produced by
 * reading what happened rather than by asking.
 */

/** A single normalised event from an agent session stream. */
export interface NormalizedEvent {
  /** Zero-based position in the transcript; the address quoted in evidence. */
  index: number;
  kind: 'tool_use' | 'tool_result' | 'assistant_text' | 'system' | 'result' | 'prompt';
  /** Tool name for tool_use events. */
  name?: string;
  /** Correlates a tool_use with its tool_result, and with vendor task events. */
  toolUseId?: string;
  /** Vendor subtype for system events (e.g. 'task_updated'). */
  subtype?: string;
  /** Flattened text: result output, assistant prose, or a serialised payload. */
  text?: string;
  /** Raw tool input for tool_use events. */
  input?: Record<string, unknown>;
  /** Vendor-signalled error flag on a tool result. */
  isError?: boolean;
  /**
   * On a tool result: the vendor's permission layer refused the call, so it did not run.
   * Kept apart from `isError`, which it also sets: a refused check says nothing about the
   * code it would have checked.
   */
  denied?: boolean;
  /** On a result event: the tool calls the vendor's permission layer refused, as it lists them. */
  denials?: unknown[];
  /** Unparsed event, retained for detectors that need vendor-specific fields. */
  raw?: Record<string, unknown>;
}

/** What a transcript adapter produces. */
export interface ParsedTranscript {
  /** Adapter that produced this, e.g. 'claude-code'. */
  adapter: string;
  /** Transcript identity quoted in evidence references. */
  source: string;
  events: NormalizedEvent[];
  /** The task prompt, if the stream carried one. */
  prompt?: string;
  /** Session id, agent name, model and working directory where the stream reports them. */
  session?: { id?: string; agent?: string; model?: string; cwd?: string };
  /** Terminal status reported by the stream, not by the agent's own summary. */
  outcome?: { status?: string; numTurns?: number; durationSeconds?: number };
}

/**
 * Kinds of finding a detector can raise.
 *
 * Each names an *observable* — something present in the transcript as output, an
 * error flag or a vendor lifecycle event. None of them name an intention.
 */
export type FindingKind =
  | 'timeout_backgrounded'
  | 'process_killed'
  | 'tool_error'
  | 'line_ending_change'
  | 'line_ending_inspection'
  | 'permission_denied'
  | 'repeated_write'
  | 'verification_failure';

/** Severity governs whether a finding becomes an attempt or a consequence. */
export type FindingSeverity = 'blocking' | 'notable' | 'informational';

/** One thing that demonstrably happened during the session. */
export interface DerivedFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** Factual one-line statement of what the transcript shows. */
  summary: string;
  /** Optional elaboration, still limited to what the transcript shows. */
  detail?: string;
  /** Transcript positions backing this finding. */
  eventIndices: number[];
  /** Verbatim excerpt, trimmed, so a reader can check the claim. */
  quote?: string;
  /** Files the finding concerns, where the transcript names them. */
  files?: string[];
}

/**
 * What an agent compared the working-tree file against when checking line endings.
 *
 * The distinction is the whole point of the measurement, because only one of the
 * two comparisons can actually detect a flip. `core.autocrlf` normalises on read,
 * so the stored blob is always LF — comparing a flipped working file against its
 * own blob therefore always agrees and reads as a false all-clear. Comparing it
 * against sibling files in the working tree is the comparison that works.
 *
 * - `sibling_file`: compared against another current-tree file, or another
 *   working-tree representation of the same content.
 * - `git_blob`: compared against git's stored object (`git show`, `git cat-file`,
 *   `git checkout-index` or equivalent).
 * - `unknown`: a check happened, but the transcript does not establish against
 *   what.
 */
export type LineEndingReference = 'sibling_file' | 'git_blob' | 'unknown';

/**
 * How a single piece of inspection evidence was established.
 *
 * - `command`: the command text itself reads carriage-return state.
 * - `output`: the tool output establishes line-ending state (e.g. file(1)
 *   reporting "with CRLF line terminators").
 * - `purpose`: the call's stated purpose names line endings, so an otherwise
 *   ambiguous observable action is attributable to that purpose.
 */
export type InspectionBasis = 'command' | 'output' | 'purpose';

export interface InspectionEvidence {
  /** Transcript position, quoted the same way every other finding quotes one. */
  index: number;
  basis: InspectionBasis;
  quote: string;
}

/**
 * Whether the session inspected line-ending state, and against what.
 *
 * Reported for every session, including sessions that never looked — an absence
 * is the answer in that case, not a missing measurement.
 */
export interface LineEndingInspection {
  checked: boolean;
  reference: LineEndingReference;
  confidence: 'VERIFIED' | 'INFERRED' | 'UNKNOWN';
  evidence: InspectionEvidence[];
  /** Transcript positions, for callers that want the addresses alone. */
  eventIndices: number[];
}
