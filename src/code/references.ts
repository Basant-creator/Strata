/**
 * Pull the things a developer *named outright* out of a sentence.
 *
 * Why this is separate from ranking
 * ---------------------------------
 * The resolver used to test the whole query string for an exact path, an exact symbol,
 * and then fall through to scoring files by shared words. That works when the query *is*
 * a path and fails the moment it is a sentence containing one — and a sentence containing
 * one is what a developer actually types. Measured: the query
 *
 *   "Make cache lookups reliable in backend/src/services/trackCacheService.ts, ..."
 *
 * resolved lexically to five files, the extra four dragged four unrelated subsystems into
 * the neighbourhood, and the commit that created the named file dropped out of the pack
 * entirely. Dropping the same path in on its own resolved it exactly and kept the commit.
 * The difference between the two was punctuation.
 *
 * So: a path or a symbol written anywhere in the query is a *claim about what is being
 * asked*, and it is treated as one. Everything here is syntax, not scoring — this module
 * never looks at the index and never decides which reference is best. It answers "what
 * did they name?"; `CodeGraph` answers "does it exist?".
 */

/** Extensions the indexer registers. A bare filename must carry one of these to count. */
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'prisma', 'sql', 'yaml', 'yml', 'toml', 'csv', 'graphql',
]);

/**
 * Words that are spelled like identifiers but are being used as English.
 *
 * Kept deliberately short. This is not the lexical stopword list: a term only reaches the
 * symbol lookup if it *exactly* matches an indexed symbol name, case included, so prose
 * filters itself out. These are the handful that collide in practice.
 */
const PROSE_IDENTIFIERS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'versus', 'vs',
  'when', 'where', 'what', 'why', 'how', 'make', 'made', 'fix', 'fixed', 'add',
  'added', 'remove', 'change', 'changed', 'update', 'use', 'used', 'using',
  'reliable', 'lookups', 'lookup', 'should', 'would', 'could', 'still', 'was',
]);

export type ReferenceKind = 'path' | 'identifier';

export interface ExplicitReference {
  /** The token exactly as it appeared, punctuation stripped. */
  text: string;
  kind: ReferenceKind;
  /**
   * True when the token is unmistakably a claim about a repository file — it carries a
   * known source or data extension. Only these are strong enough that failing to resolve
   * one is an error rather than a shrug: `and/or` has a slash and is not a path claim.
   */
  assertsFile: boolean;
}

/** Trailing and leading punctuation a path or identifier never actually contains. */
const LEAD = /^[([{<"'`]+/;
const TRAIL = /[)\]}>"'`.,;:!?]+$/;

export function stripPunctuation(token: string): string {
  let out = token.replace(LEAD, '');
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(TRAIL, '');
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * A name written as a call: `forbidden()`, `unauthorized()`, `notFound(`.
 */
const CALL = /^([A-Za-z_$][A-Za-z0-9_$]*)\(.*$/;
const PATH_CHARS = /^[A-Za-z0-9_.@/\\-]+$/;
const BARE_FILENAME = /^[A-Za-z0-9_@-]+(\.[A-Za-z0-9]+)+$/;
const NUMERIC = /^[0-9.]+$/;

/**
 * Everything in *query* that names a file or an identifier.
 *
 * Order is query order, and duplicates are dropped: the first mention wins, because a
 * developer who names a file and then refers to it again has named one thing.
 */
export function extractReferences(query: string): ExplicitReference[] {
  const out: ExplicitReference[] = [];
  const seen = new Set<string>();

  for (const rawToken of query.split(/[\s]+/)) {
    const stripped = stripPunctuation(rawToken);
    const token = CALL.exec(stripped)?.[1] ?? stripped;
    if (!token || seen.has(token)) continue;

    const reference = classify(token);
    if (!reference) continue;
    seen.add(token);
    out.push(reference);
  }
  return out;
}

function classify(token: string): ExplicitReference | null {
  // A URL is not a repository path, however many slashes it has.
  if (token.includes('://')) return null;
  if (NUMERIC.test(token)) return null;

  const normalized = token.replace(/\\/g, '/');
  const extension = normalized.includes('.')
    ? normalized.slice(normalized.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const known = KNOWN_EXTENSIONS.has(extension);

  if (normalized.includes('/') && PATH_CHARS.test(token)) {
    // A slash alone is weak evidence — "and/or", "cache/lookup" — so a path without a
    // recognised extension is offered but never asserted.
    return { text: normalized, kind: 'path', assertsFile: known };
  }
  if (known && BARE_FILENAME.test(normalized)) {
    return { text: normalized, kind: 'path', assertsFile: true };
  }
  if (IDENTIFIER.test(token) && token.length >= 3 && !PROSE_IDENTIFIERS.has(token.toLowerCase())) {
    return { text: token, kind: 'identifier', assertsFile: false };
  }
  return null;
}
