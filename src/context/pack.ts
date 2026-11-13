/**
 * The context pack: what the engine hands an agent, and how it is rendered.
 *
 * Two constraints shape this type.
 *
 * Every historical statement carries its own provenance. Not the pack, not the section —
 * the individual statement, because a single section routinely mixes a changed-file list
 * (VERIFIED, git said so), a commit message (DECLARED, the author said so) and a causal
 * link between them (INFERRED, this engine said so). Collapsing those into one label
 * would let the weakest claim borrow the strongest one's authority.
 *
 * And absence is a value. A section with nothing behind it renders as UNKNOWN rather than
 * disappearing, because "Strata has no record of a previous attempt here" and "there was
 * no previous attempt" are different facts, and only the first one is true.
 */

import { Applicability, renderApplicabilityBlock } from './applicability.js';
import { isRecordId } from '../code/graph.js';

export type Provenance = 'VERIFIED' | 'DECLARED' | 'INFERRED' | 'UNKNOWN';

/** One claim, with the evidence that backs it. */
export interface Statement {
  statement: string;
  provenance: Provenance;
  /** Commit SHAs, file paths, record ids. Empty is legal only for UNKNOWN. */
  evidence: string[];
}

/**
 * Why a file is in the neighbourhood, structurally.
 *
 * Deliberately separate from the score that orders the list. The class is a fact
 * about the graph — the query named this file, or an edge reaches it, or neither
 * and it merely shares words. The score is a preference. Letting the two mix is
 * how a file with four matching words ends up above the file the request named,
 * so classification happens first and ranking only ever reorders within a class.
 */
export type CodeRelevance =
  | 'DIRECT_TARGET' | 'DIRECTLY_RELATED' | 'INDIRECTLY_RELATED' | 'LEXICAL_ONLY';

export interface CodeNeighbor {
  path: string;
  distance: number;
  relevance: CodeRelevance;
  reasons: string[];
  symbols?: string[];
}

export interface RelationshipEdge {
  from: string;
  kind: 'imports' | 'imported-by' | 'references' | 'referenced-by' | 'defines';
  to: string;
  detail?: string;
  provenance: Provenance;
}

/**
 * How a commit relates to the target the query resolved to.
 *
 * This is the pack's most load-bearing label after provenance, and for the same reason:
 * without it an agent cannot tell a commit that changed the file it is about to edit from
 * a commit that happens to share three words with the question. Both used to be rendered
 * as identical bullet points.
 */
export type HistoryRelation =
  | 'DIRECT_TARGET' | 'DIRECTLY_RELATED' | 'INDIRECTLY_RELATED' | 'LEXICAL_ONLY';

export interface HistoricalEvent {
  hash: string;
  shortHash: string;
  subject: string;
  authoredAt: number;
  authorName: string;
  /** Files in this commit that are also in the neighbourhood, target files first. */
  touchedFiles: string[];
  /** In-scope files beyond the display cap. Stated rather than hidden. */
  touchedFilesOmitted?: number;
  relation: HistoryRelation;
  /** Resolved target files this commit changed. Empty unless DIRECT_TARGET. */
  anchorFiles: string[];
  /** Earliest indexed commit to touch a target file — mechanically, the one that made it. */
  introducedAnchor?: boolean;
  /**
   * Set when the history ranking found this commit by what it says, not only by what it
   * touched: its subject uses the request's words, or it is one end of a revert. Such a
   * commit, ranked near the top, keeps its decision and its line under a tight budget.
   */
  matchesRequest?: boolean;
  provenance: Provenance;
  /**
   * What the commit actually did to the neighbourhood.
   *
   * The subject line alone is a pointer, not a fact — measured on a history-dependent
   * task, an agent handed one still had to run `git show` to learn anything, and saved
   * nothing over a baseline doing its own archaeology. These are exact diff hunks, so
   * they are VERIFIED; the subject beside them stays DECLARED.
   */
  changes?: HistoricalChange[];
  /** A file read out of history because it is not at HEAD. */
  historicalFiles?: HistoricalFileEvidence[];
  /** Files this commit also touched, named but not diffed. */
  alsoChanged?: string[];
  alsoChangedOmitted?: number;
}

export interface HistoricalChange {
  path: string;
  previousPath?: string;
  status: string;
  hunks: string[];
  hunksOmitted: number;
  linesOmitted: number;
  provenance: Provenance;
}

export interface HistoricalFileEvidence {
  path: string;
  status: string;
  sourceCommit: string;
  lines: string[];
  linesOmitted: number;
  provenance: Provenance;
}

/**
 * What the target does now, quoted from the working tree.
 *
 * The pack used to name the files and leave the agent to open them. Measured: it opened
 * them, every time, before doing anything else.
 */
export interface CurrentBehavior {
  file: string;
  /** `exported: false` marks a module-level declaration; only the human view lists those. */
  signatures: { name: string; kind: string; line: number; text: string; exported?: false }[];
  signaturesOmitted: number;
  totalLines: number;
  provenance: Provenance;
}

/** One place the target is used, with the line number the index already held. */
export interface CallSite {
  from: string;
  line: number;
  symbol: string;
  target: string;
  provenance: Provenance;
}

/**
 * Whether a historical decision still describes the code.
 *
 * ACTIVE and SUPERSEDED are measured against the file at HEAD — which is every later
 * commit's accumulated effect, so this consults subsequent history by construction rather
 * than assuming a change stands because it is old. UNKNOWN is used freely: a change that
 * only partly survives a later rewrite has not been shown to hold *or* to have been
 * overturned, and guessing either way is the kind of unearned certainty the pack refuses.
 */
export type DecisionStatus = 'ACTIVE' | 'SUPERSEDED' | 'UNKNOWN';

export interface HistoricalDecision {
  path: string;
  /** True when this file is the resolved target rather than a travelling companion. */
  inTarget: boolean;
  commit: string;
  commitSubject: string;
  authoredAt: number;
  changeKind: string;
  changedLines: number;
  /** The lines that used to be there. Exact, never paraphrased. */
  historicalState: string[];
  historicalOmitted: number;
  /** What replaced them, and whether it is what the file holds now. */
  currentState: string[];
  currentOmitted: number;
  currentIsAtHead: boolean;
  survivingLines: number;
  addedLines: number;
  status: DecisionStatus;
  statusReason: string;
  statusProvenance: Provenance;
  supersededBy?: { shortHash: string; subject: string };
  /** Later commits to the same file. What happened next, named only. */
  consequences: { shortHash: string; subject: string }[];
  /** Evidence travelling with the decision — a test added alongside it, typically. */
  support: { kind: string; reference: string; quote?: string; provenance: Provenance }[];
  whyItMatters: Statement[];
  /** Raised when the task names something an active decision moved away from. */
  caution?: Statement;
}

export interface RecordExtract {
  id: string;
  title: string;
  intent: string;
  intentConfidence: Provenance;
  attempts: { approach: string; status: string; failureReason?: string; confidence: Provenance }[];
  consequences: string[];
  evidence: string[];
}

/**
 * One Strata record as a developer reads it: whole, attributed, and placed.
 *
 * Only built for the human view. The agent pack flattens records into labelled
 * statements capped to fit a context window; a person reading one file's history wants
 * the record itself — who wrote it, what was tried in order, what replaced what — and
 * has the screen to read it on. Every field is the record's own content with its own
 * confidence; nothing is summarised or upgraded.
 */
export interface MemoryRecord {
  id: string;
  title: string;
  author: string;
  recordedAt: number;
  /**
   * How the record relates to what was asked about: it names the target itself, it names
   * only a file connected to the target, or it matched on wording alone.
   */
  about: 'target' | 'connected' | 'wording';
  files: string[];
  /** 'human', 'agent', or 'system' — a record Strata derived itself is 'system'. */
  authorType: string;
  intent: string;
  intentConfidence: Provenance;
  attempts: {
    sequence?: number; approach: string; status: string; failureReason?: string; replacedBy?: string;
    confidence: Provenance; evidence?: string[];
  }[];
  constraints: { statement: string; status: string; confidence: Provenance; evidence?: string[]; statedBy?: string }[];
  consequences: { statement: string; confidence: Provenance; evidence?: string[]; statedBy?: string }[];
  /** Reasons stated during the work, quoted, each with where it was stated. */
  reasons: { statement: string; confidence: Provenance; evidence: string[]; statedBy?: string; precedesAttempt?: number }[];
  /** The record's evidence list: transcript positions, commits, diffs. */
  evidence: { type: string; reference: string; description?: string; confidence: Provenance }[];
  /** Symbols the record names on its files, and whether the index holds each one now. */
  symbols: { file: string; name: string; indexed: boolean }[];
  result: { status: string; summary?: string };
  /** The record's own status, and what replaced it, when the author says. */
  status: string;
  supersededBy?: string;
  /** Commits the record cites that the store confirms, as short hashes. */
  commits: string[];
  /**
   * Sentences of the record that git contradicts: each names a commit and a file, and that
   * commit changed none of the files named. VERIFIED facts about the commits; the record is
   * shown unchanged beside them.
   */
  contradictions?: { commit: string; files: string[]; changed: string[]; sentence: string }[];
}

export interface ContextPack {
  target: {
    query: string;
    type: string;
    resolution: string;
    files: string[];
    symbols: { name: string; kind: string; file: string; line: number }[];
    /** Each resolved file with the query text and the reason it resolved. */
    /** `plainWord`: an explicit_symbol anchor reached through a plain English word (graded MEDIUM). */
    /** `active`: a wording match chosen because it is the one in the developer's current work. */
    anchors?: { file: string; kind: string; matched: string; plainWord?: boolean; active?: boolean }[];
    /**
     * How far the caller should trust this target, and why.
     *
     * Stated rather than implied, because every other field in this object reads
     * the same whether the engine knew the answer or returned five guesses.
     */
    confidence: { level: 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_FOUND'; reason: string };
    /** Files the query asserted that the index does not hold. */
    unresolved?: string[];
    /**
     * For each directory the query named: how many indexed files it holds and which the
     * resolver left out. Human view only; a view that covers five of eight files says so.
     */
    directories?: { directory: string; indexedFiles: number; leftOut: string[] }[];
  };
  /**
   * Set when the query named a file that does not exist in the index.
   *
   * The pack is returned empty rather than filled with the next-best guess: an answer
   * about a different file, delivered confidently, is worse than no answer, because
   * nothing downstream can tell that the question was never answered.
   */
  targetNotFound?: boolean;
  whyThisAreaMatters: Statement[];
  codeNeighborhood: CodeNeighbor[];
  /** What the target does now, quoted from the working tree. */
  currentBehavior: CurrentBehavior[];
  /** Where the target is used, with line numbers. */
  callSites: CallSite[];
  relationships: RelationshipEdge[];
  /** Decisions the history records, with whether each still holds. */
  historicalDecisions: HistoricalDecision[];
  historicalContext: HistoricalEvent[];
  /** Ordered chains where one commit to the same file followed another. */
  changeChains: {
    files: string[];
    sequence: { shortHash: string; subject: string; explained: boolean }[];
    /** Steps in the chain nothing accounts for. Stated, not smoothed over. */
    gaps: string[];
  }[];
  decisionsAndConstraints: Statement[];
  /**
   * Recorded conditions a later change must respect.
   *
   * Kept apart from `decisionsAndConstraints`, which carries a record's intent.
   * What one change was for and what every future change still has to honour are
   * different claims, and reading them as one sentence is how a constraint gets
   * lost behind the story of the change that discovered it.
   */
  constraints: Statement[];
  previousAttempts: Statement[];
  consequences: Statement[];
  /** The records behind the statements above, whole. Present only in the human view. */
  memory?: MemoryRecord[];
  evidence: string[];
  /**
   * What the pack could not establish.
   *
   * Collected in one place rather than left implicit in empty sections, because "Strata
   * has no record of this" and "this did not happen" are different facts and only the
   * first one is true.
   */
  uncertainty: string[];
  provenanceSummary: Record<Provenance, number>;
  diagnostics: {
    indexed: boolean;
    filesInIndex: number;
    /**
     * What the caller is actually being handed.
     *
     * Reported so an oversized pack is visible as a ranking failure rather than
     * being absorbed by raising the budget — the counts say whether the engine
     * narrowed the repository or merely trimmed the text.
     */
    scope: {
      targets: number;
      neighborhoodFiles: number;
      symbols: number;
      relationships: number;
    };
    depth: number;
    maxTokens: number;
    estimatedTokens: number;
    truncated: boolean;
    /** True when trimming ran out of safe things to remove before reaching the budget. */
    budgetExceeded: boolean;
    sectionsTruncated: string[];
    /**
     * Records that were selected for this pack and whose every statement the budget then
     * removed.
     *
     * Named rather than left out, because the two look identical in a rendered pack and
     * mean opposite things: a record missing because nothing was written about this area,
     * and a record missing because it did not fit. Without this the pack can show a
     * record about a neighbouring file and silently omit the one about the target.
     */
    recordsOmitted: string[];
    /**
     * Set when the budget removed the explanatory notices for DECLARED claims and UNKNOWN
     * decisions. The per-line boundaries — UNVERIFIED CLAIM, NOT ESTABLISHED — stay.
     */
    claimsCompact?: boolean;
    notes: string[];
  };
  /**
   * How far this pack can answer the request: SUPPORTED, PARTIAL, LOW VALUE or NOT
   * APPLICABLE, with the findings that decided it. Set by the engine after the budget, so
   * it describes the pack as returned. See `applicability.ts`.
   */
  applicability?: Applicability;
}

export interface RenderOptions {
  /**
   * Add the applicability block, at most *maxChars* characters, after the target lines.
   *
   * Outside the token budget, and so not part of what `estimatedTokens` measures: the
   * block is added to the pack the budget produced and takes nothing from it.
   */
  applicability?: { maxChars?: number };
}

/**
 * Cap a recorded statement, and say so when it does not fit.
 *
 * Found in real agent validation, and it is a context-integrity bug rather than a
 * formatting one. A 961-character recorded decision was cut to 400 with nothing to
 * mark the cut: the line ended mid-word and ran straight into its evidence refs.
 * An agent read the fragment as the whole record, and confidently disputed a claim
 * the record had actually made 150 characters past the cut. Strata invented
 * nothing — it amputated silently, which produced the same wrong answer.
 *
 * The marker is counted *inside* the limit rather than added to it, so a truncated
 * statement is never longer than one that fit. Signalling the loss therefore cannot
 * push a pack over budget and evict some other piece of evidence.
 *
 * Only the body is cut. The `[REC-n] path —` prefix carries the record id and the
 * link, and a statement that loses those is unattributable whatever else survives.
 *
 * A statement may end with a dated note that it no longer holds ("… No longer holds (noted
 * 2026-11-13): since 622cc5f …"), which is how a consequence, having no status of its own,
 * is marked out of date. Cut from the end, REC-16's 342-character consequence kept its
 * stale sentence whole and its note as "since 622cc5f, recorde": the part that says the
 * claim is no longer true is the part that went. So where there is such a note the
 * sentence before it gives way first, with ` […] ` where it was cut, and the note is cut
 * from its end only when it cannot fit whole beside the opening of the sentence.
 */
export function capStatement(prefix: string, body: string, limit: number): string {
  const full = `${prefix}${body}`;
  if (full.length <= limit) return full;

  const marker = ` … [TRUNCATED — original ${body.length} chars]`;
  const room = limit - prefix.length - marker.length;
  // A limit too small to hold the prefix and the marker still has to signal the
  // loss: better a bare marker than a fragment that looks whole.
  if (room <= 0) return `${prefix}${marker}`;

  const note = DATED_NOTE.exec(body);
  if (note && note.index > 0) {
    const tail = body.slice(note.index);
    const headRoom = room - MIDDLE_CUT.length - tail.length;
    // The note whole: nothing after it was cut, so the marker carries no ellipsis.
    if (headRoom >= NOTE_HEAD_CHARS) {
      return `${prefix}${body.slice(0, headRoom).trimEnd()}${MIDDLE_CUT}${tail}${marker.slice(' …'.length)}`;
    }
    const tailRoom = room - MIDDLE_CUT.length - NOTE_HEAD_CHARS;
    if (tailRoom >= note[0].length) {
      return `${prefix}${body.slice(0, NOTE_HEAD_CHARS).trimEnd()}${MIDDLE_CUT}${tail.slice(0, tailRoom)}${marker}`;
    }
  }
  return `${prefix}${body.slice(0, room)}${marker}`;
}

/** A dated note that a recorded statement no longer holds, as written in the record. */
const DATED_NOTE = /\b(?:Superseded|No longer holds) \(noted \d{4}-\d{2}-\d{2}\):/;
/** Where text was cut from the middle of a statement, before its dated note. */
const MIDDLE_CUT = ' […] ';
/** The least of a statement's opening kept before its note, so what the note is about stays readable. */
const NOTE_HEAD_CHARS = 60;

/**
 * Token estimate.
 *
 * Deliberately a character heuristic rather than a real tokenizer: the budget exists to
 * keep the pack small and predictable, and pulling in a tokenizer would add a dependency
 * and a model assumption for a number that only needs to be roughly right. Four characters
 * per token is the usual English-plus-code approximation, and it errs slightly high on
 * code, which is the safe direction for a budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const UNKNOWN_STATEMENT = (what: string): Statement => ({
  statement: `UNKNOWN — Strata holds no evidence about ${what}. This is the absence of a record, not evidence of absence.`,
  provenance: 'UNKNOWN',
  evidence: [],
});

/** The one explanation of what a DECLARED record line is. Printed once per pack. */
/*
  Why a label was not enough.

  A DECLARED record was rendered as a quotation with a notice to verify it, and an agent
  still stated three things the record never said: that a frontend had been built on a
  particular tool, that it had later been migrated, and that some entries had been dead
  "since" that migration. It had quoted the record accurately and then continued past the
  closing quotation mark in its own voice, with nothing on the page marking where the
  record ended and the inference began.

  So each claim is now a bounded unit — a header saying what it is, the record's exact
  words on their own line — and the notice says what may not be done with it: extended.
  The notice names categories of extension, not facts; it cannot know what any record
  omits and does not try to.
*/
/*
  Every word here is paid for in evidence.

  The pack has a fixed budget, and the first version of this framing cost about 150
  tokens on a real pack — recovered by thinning the VERIFIED quotes of the very commit an
  agent had misattributed, from seventeen quoted lines to eight. An explanation of how to
  read evidence is worth less than the evidence. So the wording is the minimum that
  states the boundary; "quoted exactly" is said once here rather than on every claim, and
  what VERIFIED means is left to the legend every pack already carries.
*/
export const DECLARED_RECORD_NOTICE =
  '_DECLARED CLAIMs quote a stored record exactly and are unverified. ' +
  'The quoted text is the record\'s claim. Do not extend it with facts, technology choices, ' +
  'migrations, motives, causes, or dates not stated or independently evidenced._';

/** How an UNKNOWN decision is stated as an uncertainty. Shared, so the renderer can tell it. */
export function unsettledDecision(commit: string, filePath: string): string {
  return `whether the change ${commit} made to ${filePath} still holds could not be determined.`;
}

/**
 * The boundary printed on each DECLARED record claim, under any budget.
 *
 * With the `(DECLARED)` label that opens the same line, it is the minimum a claim may be
 * shown with: declared, unverified, and a claim — the quotation marks that follow make
 * the record's words the claim. It is never compacted: only the notice explaining it is.
 */
export const DECLARED_CLAIM_HEADER = 'UNVERIFIED CLAIM:';

/** The explanation of UNKNOWN decisions. Printed once, above the first one. */
export const UNKNOWN_DECISION_NOTICE =
  '_UNKNOWN — NOT ESTABLISHED: the repository/record does not establish this attribution, ' +
  'nor that code beyond the quoted lines came from that commit._';

const RECORD_LINE = /^(\[REC-[^\]]+\](?: \[(?:ACTIVE|SUPERSEDED|UNKNOWN)\])?(?: [^—[]+ —)?) ([\s\S]*)$/;
// The ellipsis is absent when the cut was in the middle and the statement's end is whole.
const TRUNCATION = /( …)? (\[TRUNCATED — original \d+ chars\])$/;

/**
 * A DECLARED record statement, shown as the record's words.
 *
 * `[REC-6] server.ts — Recorded from Git history. Commit …` becomes
 *
 *     [REC-6] server.ts — UNVERIFIED CLAIM: "Recorded from Git history. Commit …"
 *
 * The record id, its links and any truncation marker stay outside the quotation, so
 * attribution and the notice that text was cut read exactly as before, and the quotation
 * is the record's statement byte for byte, up to the cut. A statement cut in the middle to
 * keep its dated note (`capStatement`) shows ` […] ` at the cut and ends with the note, whole.
 */
function asRecordClaim(statement: string): string {
  const m = RECORD_LINE.exec(statement);
  // A record line of an unexpected shape is still a claim: bounded whole, never plain.
  if (!m) return `${DECLARED_CLAIM_HEADER} "${statement}"`;
  const [, prefix, body] = m;
  const cut = TRUNCATION.exec(body!);
  const text = cut ? body!.slice(0, cut.index) : body!;
  const quoted = `"${text}${cut?.[1] ? ' …' : ''}"${cut ? ` ${cut[2]}` : ''}`;
  // One line: the boundary, then the record's exact words in quotation marks. Kept on the
  // line that carries the DECLARED label, so no line of the pack shows a claim without its
  // provenance, whatever the budget.
  return `${prefix} ${DECLARED_CLAIM_HEADER} ${quoted}`;
}

/** True when the pack shows at least one DECLARED record statement. */
export function hasDeclaredRecordClaims(pack: Pick<ContextPack,
  'decisionsAndConstraints' | 'constraints' | 'previousAttempts' | 'consequences'>): boolean {
  return [...pack.decisionsAndConstraints, ...pack.constraints, ...pack.previousAttempts, ...pack.consequences]
    .some((s) => s.provenance === 'DECLARED' && s.statement.startsWith('[REC-'));
}

/*
  Two forms, one meaning.

  Each DECLARED record claim is always a bounded quotation: `(DECLARED) … UNVERIFIED CLAIM:
  "…"`. The notice explaining what that forbids is printed once above the first claim when
  the budget allows. It is the first thing the budget removes — before any evidence —
  because the repository's own evidence outranks an explanation of a record's, and the
  boundary on each line already says what the claim is. Measured: the compact form used to
  drop the boundary too, and two of six real packs showed their claims as quotation marks
  and a label alone. Removing the notice is a trimming step like any other and is
  recorded in `sectionsTruncated`.
*/
function renderStatements(
  lines: string[], title: string, statements: Statement[],
  declared?: { noticed: boolean; compact: boolean },
): void {
  lines.push(`## ${title}`);
  if (!statements.length) {
    lines.push('- UNKNOWN — nothing recorded.');
    lines.push('');
    return;
  }
  const isRecordClaim = (s: Statement): boolean =>
    declared !== undefined && s.provenance === 'DECLARED' && s.statement.startsWith('[REC-');
  if (declared && !declared.noticed && !declared.compact && statements.some(isRecordClaim)) {
    lines.push(DECLARED_RECORD_NOTICE);
    declared.noticed = true;
  }
  for (const s of statements) {
    const cited = isRecordClaim(s) ? citationsNotOnLine(s) : s.evidence;
    const ev = cited.length ? `  [${cited.join(', ')}]` : '';
    const text = isRecordClaim(s) ? asRecordClaim(s.statement) : s.statement;
    lines.push(`- (${s.provenance}) ${text}${ev}`);
  }
  lines.push('');
}

/*
  A record line names its record and files once.

  `- (DECLARED) [REC-1] src/a.ts — UNVERIFIED CLAIM: "…"  [REC-1, file:src/a.ts, commit:9b7]`
  says REC-1 and src/a.ts twice. Measured: pinning the boundary on every claim cost a tight
  pack about five tokens a line, and the budget paid for it by dropping a whole VERIFIED
  commit — while each of those lines carried a second copy of its own attribution. So the
  bracket keeps only the citations the line does not already state. The structured
  evidence is unchanged; this is rendering only.
*/
function citationsNotOnLine(s: Statement): string[] {
  const m = RECORD_LINE.exec(s.statement);
  if (!m) return s.evidence;
  const prefix = m[1]!;
  // What the line already names: files, and symbols as `file#name`, which name their file too.
  const named = /\] ([^[—]+) —$/.exec(prefix)?.[1]!.split(', ') ?? [];
  const namedFiles = new Set(named.map((n) => n.split('#')[0]!));
  return s.evidence.filter((e) => {
    if (prefix.startsWith(`[${e}]`)) return false;
    if (e.startsWith('file:')) return !namedFiles.has(e.slice('file:'.length));
    if (e.startsWith('symbol:')) return !named.includes(e.slice('symbol:'.length));
    return true;
  });
}

/**
 * Render the pack for an agent.
 *
 * Section order is the priority order the budget trims against, so the text an agent reads
 * first is also the text most likely to survive truncation.
 */
/** Trimmed-section names listed in full before the notice starts summarising itself. */
const MAX_LISTED_TRIMS = 8;

/**
 * Name what was trimmed, in a notice that cannot itself break the budget.
 *
 * The list grows by one name per trimming step, and on a tight pack that is fifteen or
 * more — long enough to cost more tokens than the section it last reclaimed. Measured: a
 * 700-token pack rendered at 706 with the full list and 661 with the shorter
 * budget-exceeded notice, so the two possible footers straddled the limit and the
 * engine's fixed-point measurement alternated between them and settled on a flag that
 * contradicted the text it returned.
 *
 * The count is kept because "trimmed 15 sections" is the part that matters once the
 * names run long.
 */
function summarizeTrimmed(sections: string[]): string {
  if (sections.length <= MAX_LISTED_TRIMS) return sections.join(', ');
  return `${sections.slice(0, MAX_LISTED_TRIMS).join(', ')} (+${sections.length - MAX_LISTED_TRIMS} more)`;
}

export function renderPack(pack: ContextPack, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# STRATA CONTEXT`);
  lines.push(`Target: ${pack.target.query}  (${pack.target.type}, resolved by ${pack.target.resolution})`);
  lines.push(`Confidence: ${pack.target.confidence.level} — ${pack.target.confidence.reason}`);
  const sc = pack.diagnostics.scope;
  lines.push(
    `Scope: ${sc.targets} target(s), ${sc.neighborhoodFiles} neighbourhood file(s), ` +
    `${sc.symbols} symbol(s), ${sc.relationships} relationship(s), ` +
    `~${pack.diagnostics.estimatedTokens} tokens of ${pack.diagnostics.filesInIndex} indexed files`);
  // Directly under the target lines, so the class is read before any evidence is. Only
  // when asked for: the budget measures the pack without it.
  const applicability = (): void => {
    if (!options.applicability || !pack.applicability) return;
    lines.push('');
    lines.push(...renderApplicabilityBlock(pack.applicability, options.applicability.maxChars));
  };

  if (pack.targetNotFound) {
    applicability();
    lines.push('');
    lines.push('## TARGET_NOT_FOUND');
    const missing = pack.target.unresolved ?? [];
    const paths = missing.filter((u) => !isRecordId(u));
    const records = missing.filter(isRecordId);
    if (paths.length) lines.push(`- The query names ${paths.map((u) => `\`${u}\``).join(', ')}, which the code index does not hold.`);
    if (records.length) lines.push(`- The store has no record ${records.join(', ')}.`);
    lines.push(`- No context was assembled. A ${paths.length ? 'file' : 'record'} that was named and not found is reported, never quietly replaced by the next-best word match.`);
    if (paths.length) lines.push('- Check the path, or run `strata index` if the file is new.');
    if (records.length) lines.push('- Check the id: every record is listed in `docs/strata/DECISIONS.md` and kept in `.strata/records/`.');
    for (const note of pack.diagnostics.notes) lines.push(`_${note}_`);
    return lines.join('\n');
  }

  if (pack.target.files.length) lines.push(`Files: ${pack.target.files.join(', ')}`);
  if (pack.target.anchors?.length) {
    lines.push(`Anchors: ${pack.target.anchors.map((a) => `${a.file} (${a.kind} "${a.matched}"${a.active ? ', in your current work' : ''})`).join('; ')}`);
  }
  const unindexed = (pack.target.unresolved ?? []).filter((u) => !isRecordId(u));
  const unrecorded = (pack.target.unresolved ?? []).filter(isRecordId);
  if (unindexed.length) lines.push(`Named but not in the index: ${unindexed.join(', ')}`);
  if (unrecorded.length) lines.push(`Named but not in the store: ${unrecorded.join(', ')}`);
  if (pack.target.symbols.length) {
    lines.push(`Symbols: ${pack.target.symbols.map((s) => `${s.name} (${s.kind}) ${s.file}:${s.line}`).join('; ')}`);
  }
  applicability();
  lines.push('');

  renderStatements(lines, 'WHY THIS AREA MATTERS', pack.whyThisAreaMatters);

  lines.push('## CODE NEIGHBORHOOD');
  if (!pack.codeNeighborhood.length) {
    lines.push('- UNKNOWN — no indexed code relationships for this target.');
  } else {
    for (const n of pack.codeNeighborhood) {
      const syms = n.symbols?.length ? `  defines: ${n.symbols.join(', ')}` : '';
      lines.push(`- [d${n.distance}] ${n.path} (${n.reasons.join('; ')})${syms}`);
    }
  }
  lines.push('');

  if (pack.currentBehavior.length || pack.callSites.length) {
    lines.push('## CURRENT BEHAVIOR  (what the code does now)');
    for (const b of pack.currentBehavior) {
      // A manifest's quoted lines are the packages it declares, not anything it exports.
      const listed = b.signatures.length && b.signatures.every((s) => s.kind === 'dependency')
        ? 'declared dependencies' : 'exports';
      lines.push(`- ${b.file} — ${b.totalLines} lines, ${listed}:  (${b.provenance}, quoted from the working tree)`);
      for (const s of b.signatures) {
        for (const [i, text] of s.text.split('\n').entries()) {
          lines.push(i === 0 ? `    ${b.file}:${s.line}  ${text.trim()}` : `        ${text.trim()}`);
        }
      }
      if (b.signaturesOmitted) lines.push(`    … ${b.signaturesOmitted} further exported symbol(s) not quoted`);
    }
    if (pack.callSites.length) {
      lines.push('- used at:');
      // The list is in priority order, which is what the budget trims by; it is read as a
      // location list, so it is shown grouped by file.
      const byFile = [...pack.callSites].sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
      for (const c of byFile) {
        lines.push(`    ${c.from}:${c.line}  ${c.symbol}  (${c.provenance})`);
      }
    }
    lines.push('');
  }

  if (pack.historicalDecisions.length) {
    lines.push('## HISTORICAL DECISIONS');
    /*
      UNKNOWN is rendered as a boundary, not as a softer ACTIVE.

      A decision whose status could not be determined was headed "decided in <commit>",
      with a VERIFIED quote of some of its lines and "… N further added line(s)" for the
      rest. An agent then credited that commit with a feature from the current file that
      the quote did not contain. The header asserted a decision; nothing said that the
      commit's role in today's code was exactly what had not been established.

      So an UNKNOWN decision is headed by what is VERIFIED — the commit changed the file —
      and its status reads NOT ESTABLISHED, with one explanation of what that withholds.
      ACTIVE and SUPERSEDED decisions, which are VERIFIED, render exactly as before.
    */
    const unknownNotice = !pack.diagnostics.claimsCompact && pack.historicalDecisions.some((d) => d.status === 'UNKNOWN');
    if (unknownNotice) lines.push(UNKNOWN_DECISION_NOTICE);
    for (const d of pack.historicalDecisions) {
      if (d.status === 'UNKNOWN') {
        lines.push(`- ${d.path}  —  changed in ${d.commit} (${d.commitSubject})`);
        lines.push(`  STATUS: UNKNOWN — NOT ESTABLISHED  (${d.statusProvenance})`);
      } else {
        lines.push(`- ${d.path}  —  decided in ${d.commit} (${d.commitSubject})`);
        lines.push(`  STATUS: ${d.status}  (${d.statusProvenance})`);
      }
      lines.push(`    ${d.statusReason}`);
      if (d.supersededBy) {
        lines.push(`    superseded by ${d.supersededBy.shortHash} ${d.supersededBy.subject}`);
      }
      if (d.historicalState.length) {
        lines.push('  HISTORICAL  (what used to be there) (VERIFIED):');
        for (const l of d.historicalState) lines.push(`    - ${l.trim()}`);
        if (d.historicalOmitted) lines.push(`    … ${d.historicalOmitted} further removed line(s)`);
      }
      if (d.currentState.length) {
        const where = d.currentIsAtHead ? 'still present at HEAD' : 'introduced here, not present at HEAD';
        lines.push(`  CURRENT  (what replaced it, ${where}) (VERIFIED):`);
        for (const l of d.currentState) lines.push(`    + ${l.trim()}`);
        if (d.currentOmitted) lines.push(`    … ${d.currentOmitted} further added line(s)`);
      }
      if (d.support.length) {
        lines.push('  SUPPORTING EVIDENCE:');
        for (const s of d.support) {
          lines.push(`    ${s.kind} ${s.reference}  (${s.provenance})`);
          if (s.quote) lines.push(`      "${s.quote.trim()}"`);
        }
      }
      if (d.consequences.length) {
        lines.push('  WHAT HAPPENED NEXT (later commits to this file, VERIFIED):');
        for (const c of d.consequences) lines.push(`    ${c.shortHash} ${c.subject}`);
      } else {
        lines.push('  WHAT HAPPENED NEXT: nothing — no later commit has touched this file. (VERIFIED)');
      }
      if (d.whyItMatters.length) {
        lines.push('  WHY THIS MATTERS:');
        for (const w of d.whyItMatters) lines.push(`    (${w.provenance}) ${w.statement}`);
      }
      if (d.caution) {
        lines.push(`  CAUTION  (${d.caution.provenance}):`);
        lines.push(`    ${d.caution.statement}`);
      }
      lines.push('');
    }
  }

  lines.push('## RELATIONSHIPS');
  if (!pack.relationships.length) {
    lines.push('- UNKNOWN — no established relationships.');
  } else {
    for (const r of pack.relationships) {
      lines.push(`- ${r.from} --${r.kind}--> ${r.to}${r.detail ? ` (${r.detail})` : ''} (${r.provenance})`);
    }
  }
  lines.push('');

  lines.push('## HISTORICAL CONTEXT');
  if (!pack.historicalContext.length) {
    /*
      An empty section means one of two opposite things, and saying the wrong one is a
      false claim rather than a thin pack.

      "No commits recorded" is a statement about the repository. When the budget removed
      the commits, the repository said nothing of the kind — Strata did — and an agent
      reading the absence as evidence would conclude the area has no history at all.
    */
    lines.push(pack.diagnostics.sectionsTruncated.some((s) => s.startsWith('history'))
      ? '- OMITTED — commits were found for these files and did not fit the budget; this is not an absence of history.'
      : '- UNKNOWN — no commits recorded against these files.');
  } else {
    for (const h of pack.historicalContext) {
      const more = h.touchedFilesOmitted ? ` (+${h.touchedFilesOmitted} more in scope)` : '';
      const origin = h.introducedAnchor ? ', introduced the target' : '';
      lines.push(`- [${h.relation}${origin}] ${h.shortHash} ${h.subject} — ${h.touchedFiles.join(', ')}${more} (commit and file list VERIFIED; subject is the author's own description, DECLARED)`);
      for (const c of h.changes ?? []) {
        const renamed = c.previousPath ? ` (renamed from ${c.previousPath})` : '';
        lines.push(`    ${c.status.toUpperCase()} ${c.path}${renamed}  (${c.provenance})`);
        for (const hunk of c.hunks) {
          for (const hl of hunk.split('\n')) lines.push(`      ${hl}`);
        }
        if (c.hunksOmitted) lines.push(`      … ${c.hunksOmitted} further hunk(s) omitted to fit the budget`);
      }
      for (const f of h.historicalFiles ?? []) {
        lines.push(`    HISTORICAL FILE ${f.path} — status: ${f.status}, read from ${f.sourceCommit} (${f.provenance})`);
        for (const fl of f.lines) lines.push(`      ${fl}`);
        if (f.linesOmitted) lines.push(`      … ${f.linesOmitted} further line(s) omitted`);
      }
      if (h.alsoChanged?.length) {
        const more = h.alsoChangedOmitted ? ` (+${h.alsoChangedOmitted} more)` : '';
        lines.push(`    also changed: ${h.alsoChanged.join(', ')}${more}`);
      }
    }
  }
  lines.push('');

  if (pack.changeChains.length) {
    lines.push('## CHANGE CHAINS  (ordering is VERIFIED; that one step caused the next is not claimed)');
    for (const chain of pack.changeChains) {
      lines.push(`- ${chain.files.join(', ')}`);
      lines.push(`  ${chain.sequence.map((s) => `${s.shortHash} ${s.subject}${s.explained ? '' : '   [why: UNKNOWN]'}`).join('\n    -> ')}`);
      for (const gap of chain.gaps) lines.push(`  GAP: ${gap}`);
    }
    lines.push('');
  }

  /*
    Recorded memory is said once, plainly, to be claims.

    A DECLARED label alone was not enough. Measured on six runs of one task, four agents
    handed a DECLARED record took its account as repository fact, ran no git to check it,
    and extended it: the record said the origins came from "the Spotify-era frontend …
    expected on port 5173", and the agents wrote that the frontend had once been Vite-based,
    which the history contradicts. None of the six agents without the record made that
    claim. The record also opened with "Recorded from Git history", which reads like
    verification and is part of the claim.

    So the first record section holding a DECLARED record statement carries one notice, and
    each such statement is shown as what the record says rather than as a sentence of the
    pack's own. Nothing is changed about the statement itself: provenance stays DECLARED,
    nothing is added to it, and the notice tells the reader what kind of line this is, not
    what to conclude from it.
  */
  const declared = { noticed: false, compact: pack.diagnostics.claimsCompact === true };
  renderStatements(lines, 'DECISIONS / CONSTRAINTS', pack.decisionsAndConstraints, declared);
  // Printed only when something was recorded. The other sections state their own
  // absence because "nothing recorded here" is itself the answer to a question the
  // reader asked; nobody asked whether a constraint exists, so an empty heading is
  // width with no content behind it.
  if (pack.constraints.length) {
    renderStatements(lines, 'CONSTRAINTS  (recorded conditions a change must respect)', pack.constraints, declared);
  }
  renderStatements(lines, 'PREVIOUS ATTEMPTS', pack.previousAttempts, declared);
  renderStatements(lines, 'CONSEQUENCES', pack.consequences, declared);

  lines.push('## EVIDENCE');
  if (!pack.evidence.length) lines.push('- UNKNOWN');
  else for (const e of pack.evidence) lines.push(`- ${e}`);
  lines.push('');

  /*
    An unsettled decision is stated once, where it is.

    Each UNKNOWN decision also appears here as "whether the change … still holds could not
    be determined" — the same fact its own block now states as NOT ESTABLISHED. Measured on
    a real pack, saying it twice cost enough of the budget to thin the VERIFIED quotes of
    exactly the commit an agent had misattributed. So an item is omitted from this section
    only while the decision it restates is rendered above; if the budget removes the
    decision, the item is shown here instead. The structured list is untouched.
  */
  const restated = new Set(pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN')
    .map((d) => unsettledDecision(d.commit, d.path)));
  const withheld = pack.uncertainty.filter((u) => !restated.has(u));
  if (withheld.length) {
    // Everything in this section is withheld, and the heading says so in the same words as
    // an UNKNOWN decision, so no item reads as a weaker form of a positive statement.
    lines.push('## UNCERTAINTY  (NOT ESTABLISHED — what Strata could not establish)');
    for (const u of withheld) lines.push(`- UNKNOWN — ${u}`);
    lines.push('');
  }

  lines.push('## PROVENANCE');
  lines.push('VERIFIED = exact git/file content. DECLARED = someone said so. INFERRED = read from evidence by Strata. UNKNOWN = not established.');
  for (const level of ['VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN'] as Provenance[]) {
    lines.push(`- ${level}: ${pack.provenanceSummary[level]} statement(s)`);
  }
  /*
    The two notices stack; they are not alternatives.

    They used to be, and because they were different lengths the flag that chose between
    them changed the size of the pack it was describing. A pack whose size fell between
    the two had no consistent answer: measured at 916 tokens against a budget of 900 it
    declared the budget unmet, which swapped in the shorter notice, which measured 898 —
    so it declared the budget met, which swapped the longer notice back. The engine's
    fixed-point measurement alternated and returned a flag contradicting its own text.

    Stacking makes the exceeded state strictly longer than the fitting one, so a pack
    that overflows still overflows once it says so, and the measurement converges. It
    also stops the notice quoting the token count, which was a second self-reference: the
    digits of the number were part of the text being counted.
  */
  if (pack.diagnostics.truncated) {
    lines.push('');
    lines.push(`_Truncated to fit ${pack.diagnostics.maxTokens} tokens; trimmed: ${summarizeTrimmed(pack.diagnostics.sectionsTruncated)}._`);
  }
  if (pack.diagnostics.budgetExceeded) {
    if (!pack.diagnostics.truncated) lines.push('');
    lines.push(`_Budget of ${pack.diagnostics.maxTokens} tokens could not be met; this is the minimum pack for this target._`);
  }
  // Said plainly, because a record that did not fit and a record that does not exist
  // render identically otherwise.
  if (pack.diagnostics.recordsOmitted?.length) {
    lines.push(`_Recorded memory exists for this area in ${pack.diagnostics.recordsOmitted.join(', ')} and did not fit this budget; omitted, not absent._`);
  }
  for (const note of pack.diagnostics.notes) lines.push(`_${note}_`);

  return lines.join('\n');
}
