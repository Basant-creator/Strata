import { z } from 'zod';

/**
 * Epistemic confidence levels for all Strata claims and context.
 * 
 * - VERIFIED: Directly supported by concrete evidence (Git commit, diff, test run, exit code).
 * - DECLARED: Explicitly stated by a human or agent (e.g. intent, task description) without independent verification.
 * - INFERRED: Derived by an AI or rule-based engine from available evidence.
 * - UNKNOWN: No reliable evidence exists. Never present an inference as verified fact.
 */
export const ConfidenceLevelSchema = z.enum([
  'VERIFIED',
  'DECLARED',
  'INFERRED',
  'UNKNOWN',
]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/**
 * Author type distinguishing human, agent, or system automation.
 */
export const AuthorTypeSchema = z.enum(['human', 'agent', 'system']);
export type AuthorType = z.infer<typeof AuthorTypeSchema>;

/**
 * Human/Author identity schema.
 */
export const AuthorSchema = z.object({
  name: z.string().min(1, 'Author name is required'),
  email: z.string().email().optional(),
  type: AuthorTypeSchema.default('human'),
});
export type Author = z.infer<typeof AuthorSchema>;

/**
 * AI Agent / Tool attribution schema.
 */
export const AgentMetadataSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  model: z.string().optional(),
  provider: z.string().optional(),
  tool: z.string().optional(),
});
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

/**
 * Types of verifiable evidence supporting a record.
 */
export const EvidenceTypeSchema = z.enum([
  'git_commit',
  'diff',
  'test_run',
  'issue',
  'benchmark',
  'log',
  'other',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/**
 * Concrete piece of evidence.
 *
 * Unlabelled evidence is DECLARED, like every other unlabelled statement: VERIFIED is a
 * claim about where the evidence came from, so whoever builds it must say so.
 */
export const EvidenceSchema = z.object({
  type: EvidenceTypeSchema,
  reference: z.string().min(1, 'Evidence reference/ID is required'),
  description: z.string().optional(),
  confidence: ConfidenceLevelSchema.default('DECLARED'),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Status of an attempted solution/approach.
 *
 * The first four are the original lifecycle. `partial` and `unknown` exist because an
 * attempt read out of a transcript often has a mixed or absent outcome, and the only
 * alternatives were to round it to `failed` — a claim the evidence does not make — or
 * to `succeeded`. What replaced an attempt is `replacedBy`, not a status: an approach
 * can have worked and still have been replaced, and "replaced" is not "failed".
 * `superseded` stays valid for records written before the distinction existed.
 */
export const AttemptStatusSchema = z.enum([
  'succeeded',
  'failed',
  'abandoned',
  'superseded',
  'partial',
  'unknown',
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/**
 * An approach or alternative attempted during development.
 */
export const AttemptSchema = z.object({
  sequence: z.number().int().nonnegative().optional(),
  approach: z.string().min(1, 'Approach description is required'),
  status: AttemptStatusSchema,
  failureReason: z.string().optional(),
  confidence: ConfidenceLevelSchema.default('DECLARED'),
  /**
   * What shows this attempt happened and how it went.
   *
   * Without it a failed attempt is an assertion and nothing more, which is fine
   * when a human wrote it down and not fine when something derived it.
   */
  evidence: z.array(z.string()).default([]),
  /** The approach that took its place, where the record names one. */
  replacedBy: z.string().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/**
 * File change type.
 */
export const FileChangeTypeSchema = z.enum(['add', 'modify', 'delete', 'rename']);
export type FileChangeType = z.infer<typeof FileChangeTypeSchema>;

/**
 * Represents a file affected by a change.
 */
export const FileChangeSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  changeType: FileChangeTypeSchema,
  symbols: z.array(z.string()).optional(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/**
 * Outcome status of a development task/change.
 */
export const ResultStatusSchema = z.enum([
  'success',
  'failure',
  'partial',
  'in_progress',
  'unknown',
]);
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

/**
 * Outcome of a development change.
 */
export const ResultSchema = z.object({
  status: ResultStatusSchema,
  summary: z.string().optional(),
});
export type Result = z.infer<typeof ResultSchema>;

/**
 * Whether a piece of recorded memory still describes the code.
 *
 * Separate from a record's `result`, which says how the work went at the time.
 * A migration can have succeeded and its constraint still be superseded years
 * later. Superseded memory is kept, never deleted: "we tried this and moved on"
 * is exactly the knowledge a later reader needs.
 */
export const MemoryStatusSchema = z.enum(['ACTIVE', 'SUPERSEDED', 'UNKNOWN']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/**
 * A condition that restricts how the code may be implemented.
 *
 * Distinct from intent. Intent says what this change was for; a constraint says
 * what any future change still has to respect, which is the part a later reader
 * needs and the part that was previously folded into the same sentence.
 *
 * A constraint with no evidence is DECLARED at best. Nothing here converts an
 * old configuration value into a requirement because it survived a long time.
 */
export const ConstraintSchema = z.object({
  statement: z.string().min(1, 'Constraint statement is required'),
  confidence: ConfidenceLevelSchema.default('DECLARED'),
  /** Commit SHAs, file paths, test names — what supports the claim. */
  evidence: z.array(z.string()).default([]),
  status: MemoryStatusSchema.default('UNKNOWN'),
  /** Who stated it, where the record knows: e.g. "the task prompt", "the agent". */
  statedBy: z.string().optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/**
 * An effect a change left behind.
 *
 * Accepts a bare string so records written before this field gained structure
 * still load: they normalise to a DECLARED statement with no evidence, which is
 * exactly what they were. Nothing is invented by the upgrade.
 */
export const ConsequenceSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { statement: value } : value),
  z.object({
    statement: z.string().min(1, 'Consequence statement is required'),
    confidence: ConfidenceLevelSchema.default('DECLARED'),
    evidence: z.array(z.string()).default([]),
    /** Who stated it, where the record knows. */
    statedBy: z.string().optional(),
  }),
);
export type Consequence = z.infer<typeof ConsequenceSchema>;

/**
 * A reason somebody stated, in their own words.
 *
 * Kept apart from the record's intent, which says what the whole piece of work was
 * for. A reason explains one choice inside it — "used the Edit tool rather than a
 * heredoc, which would write LF" — and is only ever a quotation: DECLARED, with the
 * position it was stated at. Nothing here is a reason read *into* the work; an
 * attempt followed by a success has no reason unless someone gave one.
 */
export const StatedReasonSchema = z.object({
  statement: z.string().min(1, 'Reason statement is required'),
  confidence: ConfidenceLevelSchema.default('DECLARED'),
  /** Where it was stated: transcript coordinates, commit SHAs, file paths. */
  evidence: z.array(z.string()).default([]),
  statedBy: z.string().optional(),
  /**
   * The attempt (by sequence) the statement immediately preceded, where it did. An
   * ordering in the transcript, not a claim that the reason explains that attempt.
   */
  precedesAttempt: z.number().int().positive().optional(),
});
export type StatedReason = z.infer<typeof StatedReasonSchema>;

/**
 * Unified Strata Development Context Record Schema (V0.1).
 */
export const StrataRecordSchema = z.object({
  id: z.string().min(1, 'Record ID is required'),
  schemaVersion: z.string().default('0.1.0'),
  title: z.string().min(1, 'Title is required'),
  intent: z.string().min(1, 'Intent (WHY) is required'),
  intentConfidence: ConfidenceLevelSchema.default('DECLARED'),
  author: AuthorSchema,
  agent: AgentMetadataSchema.optional(),
  files: z.array(FileChangeSchema).min(1, 'At least one file must be specified'),
  attempts: z.array(AttemptSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  /** Conditions any later change still has to respect. */
  constraints: z.array(ConstraintSchema).default([]),
  consequences: z.array(ConsequenceSchema).default([]),
  /** Reasons stated during the work, quoted. */
  reasons: z.array(StatedReasonSchema).default([]),
  /** Symbols this memory is about, where the record names them. */
  symbols: z.array(z.string()).default([]),
  /** Whether this memory still describes the code. */
  status: MemoryStatusSchema.default('UNKNOWN'),
  /** Record id that replaced this one, when the author says so. */
  supersededBy: z.string().optional(),
  result: ResultSchema,
  createdAt: z.number().int().default(() => Date.now()),
  updatedAt: z.number().int().default(() => Date.now()),
});
export type StrataRecord = z.infer<typeof StrataRecordSchema>;

/**
 * Input schema for creating a new Strata Record (CLI/MCP friendly).
 */
export const CreateRecordInputSchema = StrataRecordSchema.omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
  author: true,
}).extend({
  id: z.string().optional(),
  author: AuthorSchema.optional(),
});
/**
 * The *input* type, so schema defaults stay optional for callers.
 *
 * `z.infer` describes what comes out of a parse, where every defaulted field is
 * present. Using it for a creation API forced every caller to pass `evidence: []`
 * and `constraints: []` by hand, which is noise that also makes adding a field a
 * breaking change for every writer.
 */
export type CreateRecordInput = z.input<typeof CreateRecordInputSchema>;

/**
 * Baseline Git Commit Record.
 */
export const GitCommitRecordSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.number().int(),
  committerName: z.string().min(1),
  committerEmail: z.string(),
  committedAt: z.number().int(),
  message: z.string(),
  changedFiles: z.array(z.string()),
});
export type GitCommitRecord = z.infer<typeof GitCommitRecordSchema>;
