import {
  Attempt,
  AttemptStatusSchema,
  ConfidenceLevel,
  ConfidenceLevelSchema,
  Evidence,
  EvidenceTypeSchema,
  MemoryStatus,
  MemoryStatusSchema,
} from '../schema/types.js';

/**
 * Parsing for the colon-separated values `strata record` takes, such as
 * `--constraint "statement:confidence:status"`.
 *
 * These used to be read with `value.split(':')` and positional destructuring, so any
 * colon inside the text ended a field and everything after the next one was dropped
 * without a word: "Keep it idempotent: retries happen" lost "retries happen", and a
 * URL reference lost everything after "https". The rules below keep every character
 * the user typed:
 *
 * - The last field takes the rest of the value, colons included.
 * - Labels (a constraint's confidence and status, an attempt's status) are recognised by
 *   value, and only a valid one is read as a label. Anything else stays text.
 * - `\:` is a literal colon anywhere, for text that the rules above would still split.
 * - A colon that is part of a URL (`https://`, or a port like `:8080` after it) or of a
 *   Windows drive (`C:\`, `C:/` at the start of a field) does not separate fields.
 *
 * Labels must be written exactly as the schema spells them (`DECLARED`, `failed`); a
 * label with spaces around it, as in prose ("it failed: twice"), is read as text.
 */

const CONFIDENCES: readonly string[] = ConfidenceLevelSchema.options;
const MEMORY_STATUSES: readonly string[] = MemoryStatusSchema.options;
const ATTEMPT_STATUSES: readonly string[] = AttemptStatusSchema.options;
const EVIDENCE_TYPES: readonly string[] = EvidenceTypeSchema.options;

/** Split *raw* on the colons that separate fields, resolving `\:` to `:`. */
export function splitFields(raw: string): string[] {
  const fields: string[] = [];
  let field = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\' && raw[i + 1] === ':') {
      field += ':';
      i++;
      continue;
    }
    if (ch === ':' && !isLiteralColon(field, raw.slice(i + 1))) {
      fields.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  fields.push(field);
  return fields;
}

/** Whether a colon, with *field* before it and *rest* after it, belongs to the text. */
function isLiteralColon(field: string, rest: string): boolean {
  if (rest.startsWith('//')) return true;                          // https://
  if (field.includes('://') && /^\d/.test(rest)) return true;      // https://host:8080
  if (/^\s*[A-Za-z]$/.test(field) && /^[\\/]/.test(rest)) return true; // C:\ or C:/
  return false;
}

const join = (fields: string[]): string => fields.join(':').trim();

export interface ParsedConstraint {
  statement: string;
  confidence: ConfidenceLevel;
  status: MemoryStatus;
  evidence: string[];
}

/**
 * `statement[:confidence[:status]]`. Labels are taken from the right only when they are
 * valid, so a statement keeps its own colons. An empty confidence (`statement::ACTIVE`)
 * means the default, and a status given without a confidence (`statement:ACTIVE`) is
 * read as a status: no confidence is spelled ACTIVE or SUPERSEDED.
 */
export function parseConstraint(raw: string): ParsedConstraint {
  const fields = splitFields(raw);
  let confidence: string | undefined;
  let status: string | undefined;

  const last = fields[fields.length - 1]!;
  const beforeLast = fields[fields.length - 2];
  if (fields.length >= 3 && MEMORY_STATUSES.includes(last)
      && (beforeLast === '' || CONFIDENCES.includes(beforeLast!))) {
    status = last;
    confidence = beforeLast || undefined;
    fields.splice(-2);
  } else if (fields.length >= 2 && CONFIDENCES.includes(last)) {
    confidence = last;
    fields.pop();
  } else if (fields.length >= 2 && MEMORY_STATUSES.includes(last)) {
    status = last;
    fields.pop();
  }

  return {
    statement: join(fields),
    confidence: (confidence ?? 'DECLARED') as ConfidenceLevel,
    status: (status ?? 'UNKNOWN') as MemoryStatus,
    evidence: [],
  };
}

/**
 * `approach[:status[:failureReason]]`. The status is the first field after the approach
 * that is a valid attempt status; the text before it is the approach and everything
 * after it is the reason. With no status in the value, all of it is the approach and the
 * attempt is recorded as succeeded.
 */
export function parseAttempt(raw: string): Attempt {
  const fields = splitFields(raw);
  const at = fields.findIndex((f, i) => i > 0 && ATTEMPT_STATUSES.includes(f));
  if (at === -1) {
    return { approach: join(fields), status: 'succeeded', confidence: 'DECLARED', evidence: [] };
  }
  const reason = join(fields.slice(at + 1));
  return {
    approach: join(fields.slice(0, at)),
    status: fields[at] as Attempt['status'],
    ...(reason ? { failureReason: reason } : {}),
    confidence: 'DECLARED',
    evidence: [],
  };
}

/** `approach[:failureReason]`. The first separating colon ends the approach. */
export function parseFailedAttempt(raw: string): Attempt {
  const [approach, ...reason] = splitFields(raw);
  return {
    approach: (approach ?? '').trim(),
    status: 'failed',
    failureReason: join(reason) || 'Approach failed',
    confidence: 'DECLARED',
    evidence: [],
  };
}

export interface ParsedEvidence {
  evidence: Evidence;
  /** Set when the value had to be read differently from what was probably meant. */
  warning?: string;
}

/**
 * `type:reference[:description]`, stored as DECLARED: the user typed it and Strata has
 * not checked it. A first field that is not an evidence type used to be dropped, along
 * with the rest of a URL; the whole value is now kept as the reference of an `other`
 * item, with a warning, so nothing the user wrote disappears.
 */
export function parseEvidence(raw: string): ParsedEvidence {
  const fields = splitFields(raw);
  const type = fields[0]!.trim();
  if (EVIDENCE_TYPES.includes(type)) {
    const description = join(fields.slice(2));
    return {
      evidence: {
        type: type as Evidence['type'],
        reference: (fields[1] ?? '').trim() || 'unknown',
        ...(description ? { description } : {}),
        confidence: 'DECLARED',
      },
    };
  }
  const whole = join(fields);
  return {
    evidence: { type: 'other', reference: whole || 'unknown', confidence: 'DECLARED' },
    warning:
      `evidence "${whole}" does not start with a known type (${EVIDENCE_TYPES.join(', ')}); ` +
      'stored whole as an "other" reference',
  };
}
