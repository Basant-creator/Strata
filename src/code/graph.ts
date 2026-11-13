/**
 * Read side of the code graph: target resolution and neighbourhood expansion.
 *
 * The context engine asks this module three things — "what did the user mean?", "what is
 * next to it?", and "which commits touched any of that?" — and nothing else. Ranking,
 * budgeting and rendering live in `src/context/`, so this file stays a query layer with
 * no opinions about presentation.
 *
 * Expansion is breadth-first over *established* edges only. An edge with a NULL target
 * (an unresolved import, an unbound identifier) contributes nothing to the neighbourhood:
 * it is recorded for honesty but it cannot carry the walk, because following it would
 * mean guessing where it points.
 */

import { StrataDatabase } from '../storage/db.js';
import { extractReferences, stripPunctuation } from './references.js';

export type TargetType = 'file' | 'symbol' | 'task';

/**
 * How a file earned its place as a target.
 *
 * The distinction is load-bearing downstream. An anchor the developer named outright is a
 * statement about what the question is about; a file that scored well on shared words is a
 * guess. History is gathered around the first kind and ranked against the second, which is
 * the whole point of the anchoring pipeline — see `src/context/history.ts`.
 */
export type AnchorKind = 'explicit_path' | 'explicit_symbol' | 'file_name' | 'record' | 'lexical';

export interface TargetAnchor {
  file: string;
  kind: AnchorKind;
  /** The query text that produced this anchor. */
  matched: string;
  /** Symbols named in the query that this file defines. */
  symbols: SymbolRow[];
  /**
   * Set when an `explicit_symbol` anchor came from a plain word — not code-shaped, not in
   * backticks, not the whole request — that happens to spell an exported symbol. It is
   * still an anchor, graded MEDIUM rather than HIGH: the request used the word, it did not
   * clearly name the symbol. Set the same way on a `file_name` anchor ("Compiler" for
   * `compiler.ts`), so history does not count it as a file the request named.
   */
  plainWord?: boolean;
  /**
   * Set when the anchor is a package manifest reached through a dependency it declares,
   * named in a request about packages ("upgrade phaser"). Graded MEDIUM, like a plain
   * word: the request named the package, not the file.
   */
  dependency?: boolean;
  /**
   * Set on a wording match chosen because, of the files the words tie between, it is the
   * one the developer is changing now. Graded MEDIUM: the words matched it, and the
   * working tree singled it out; neither named it.
   */
  active?: boolean;
}

export type TargetResolution =
  | 'exact_file' | 'path_suffix' | 'exact_symbol'
  | 'embedded_path' | 'embedded_symbol' | 'embedded_name' | 'named_record'
  | 'lexical' | 'target_not_found' | 'none';

/**
 * How much weight the caller may put on the target.
 *
 * Separate from `TargetResolution`, which says *how* a target was reached. A
 * resolution is a mechanism; this is a claim about reliability, and the two come
 * apart exactly where it matters: a name defined in six files resolves by a
 * perfectly ordinary lexical path and is still not a target. Without somewhere to
 * say that, the pack reads identically whether the engine knows the answer or is
 * returning its best five guesses.
 */
export type TargetConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_FOUND';

export interface TargetConfidenceAssessment {
  level: TargetConfidence;
  /** Plain-language grounds, carried into the pack rather than recomputed there. */
  reason: string;
}

export interface ResolvedTarget {
  type: TargetType;
  /** Files the query resolved to, best first. Empty when nothing matched. */
  files: string[];
  /** Symbols the query resolved to, when the query named one. */
  symbols: SymbolRow[];
  /** What the user actually typed. */
  query: string;
  /** How the resolution was reached, for the pack's provenance section. */
  resolution: TargetResolution;
  /** Every resolved target with the reason it resolved, best first. */
  anchors: TargetAnchor[];
  /**
   * Files the query asserted and the index does not hold.
   *
   * Recorded rather than ignored: a query naming a path that does not exist used to
   * degrade silently into a word search, so the caller got a confident pack about some
   * other file and no indication that the thing they asked for was never found.
   */
  unresolved: string[];
  /** How far the caller should trust this target, and why. */
  confidence: TargetConfidenceAssessment;
}

/** Grade a resolution. Deterministic: same anchors in, same grade out. */
export function assessConfidence(
  resolution: TargetResolution,
  anchors: TargetAnchor[],
  unresolved: string[],
  margin?: { top: number; second: number; survivors: number },
): TargetConfidenceAssessment {
  if (resolution === 'target_not_found') {
    return { level: 'NOT_FOUND', reason: describeMissing(unresolved) };
  }
  if (!anchors.length) {
    return { level: 'LOW', reason: 'no reliable repository target' };
  }

  const primary = anchors[0]!;
  const extra = anchors.length > 1 ? `, plus ${anchors.length - 1} more from the same request` : '';
  if (primary.kind === 'explicit_path') return { level: 'HIGH', reason: `explicit path${extra}` };
  if (primary.kind === 'record') return { level: 'HIGH', reason: `names record ${primary.matched}${extra}` };
  if (primary.dependency) {
    return { level: 'MEDIUM', reason: `the request is about packages and names "${primary.matched}", a dependency this manifest declares${extra}` };
  }
  if (primary.kind === 'explicit_symbol' && primary.plainWord) {
    return { level: 'MEDIUM', reason: `a plain word in the request, "${primary.matched}", is also an exported symbol's name${extra}` };
  }
  if (primary.kind === 'explicit_symbol') return { level: 'HIGH', reason: `explicit symbol${extra}` };
  if (primary.kind === 'file_name') return { level: 'MEDIUM', reason: `filename match${extra}` };

  // Lexical only. A clear winner is worth something; a five-way tie is not.
  if (primary.active) {
    return { level: 'MEDIUM', reason: 'matched on shared words, and the one such file in your current work (uncommitted, or in recent commits)' };
  }
  if (margin) {
    const clear = margin.survivors === 1 || margin.top >= margin.second * 2;
    return clear
      ? { level: 'MEDIUM', reason: 'matched on shared words, with one clear best file' }
      : {
          level: 'LOW',
          reason: `${margin.survivors} files match the query words about equally; no single target`,
        };
  }
  return { level: 'LOW', reason: 'matched on shared words only' };
}

/** Anchor kinds the developer stated outright, as against the ones we guessed. */
const EXPLICIT_KINDS = new Set<AnchorKind>(['explicit_path', 'explicit_symbol', 'file_name', 'record']);
const WEAK_KINDS = new Set<AnchorKind>(['lexical']);
/** Ceiling on a merged multi-clause result, so coordination cannot widen the net. */
const MAX_MERGED_ANCHORS = 6;
/**
 * Above this many clauses a request is a report, not a coordinated instruction.
 *
 * Coordination splits "update X in a.ts and keep the ledger behaviour" into its two
 * subjects. A pasted bug report has no such structure: its commas and "and"s cut it into
 * seven to twenty-nine fragments (measured on eight real reports), each resolved on two or
 * three words, so "do not install dependencies" anchored `dependencies.js` and the report's
 * subject never met its own words.
 */
const MAX_COORDINATED_CLAUSES = 5;
/** Words from which a request that names nothing by its form is a description; see `resolveRequest`. */
const DESCRIPTION_WORDS = 12;

/**
 * Split a request at coordinating boundaries.
 *
 * Only a boundary with substantive text on both sides counts, so "fix the CORS
 * handling and origins" stays one clause while "…in server.ts and keep the stock
 * ledger behaviour" becomes two. Conservative by design: a wrong split widens the
 * neighbourhood, which is the failure this engine exists to prevent.
 */
export function splitClauses(query: string): string[] {
  const parts = query
    .split(/\s*[;]\s*|\s+\band\b\s+|\s+\bplus\b\s+|\s*,\s*(?=\S)/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [query.trim()].filter(Boolean);
  // A fragment carrying no term of its own cannot name a target; fold it away.
  const substantive = parts.filter((p) => tokenize(p).length > 0 || /[./\\]/.test(p));
  return substantive.length >= 2 ? substantive : [query.trim()];
}

/** A name defined in more files than this is a vocabulary, not a target. */
const MAX_SYMBOL_FANOUT = 4;

/**
 * Words that make a request about packages: their versions, installation and upgrades.
 *
 * A package's name is often a plain word too: "react", "express", "next", "commander".
 * Alone it says nothing about the manifest, and "why doesn't the navbar react to clicks"
 * must not resolve to `package.json`. Next to one of these words it does: "upgrade
 * phaser", "bump react to 19", "which version of vite". "update" is left out on purpose:
 * "update the react state" is about code far more often than about a version.
 */
const DEPENDENCY_INTENT = new Set([
  'upgrade', 'upgrades', 'upgrading', 'upgraded', 'downgrade', 'downgrading', 'bump', 'bumping',
  'version', 'versions', 'install', 'installed', 'installing', 'uninstall', 'reinstall',
  'dependency', 'dependencies', 'deps', 'package', 'packages', 'pin', 'pinned', 'unpin',
  'latest', 'major', 'semver', 'npm', 'yarn', 'pnpm', 'migrate', 'migrating', 'migration',
]);
/** Files a directory reference may resolve to — the same ceiling the other paths had. */
const MAX_DIRECTORY_FILES = 5;
/** Files considered inside a directory before ranking picks among them. */
const MAX_DIRECTORY_CANDIDATES = 200;

/**
 * Does *name* look like code rather than English?
 *
 * An internal capital (`generateDriftPlaylist`, `FlowEngine`), an underscore, a digit next
 * to a letter, a `$`, backticks around it in the request, or a call written out
 * (`forbidden()`, "forbidden()"). "call", "state" and "handle" are words first and symbols
 * by coincidence; a camelCase name is a reference on sight, and so is a name followed by
 * its parentheses.
 */
export function isCodeShaped(name: string, text: string): boolean {
  return /[a-z0-9][A-Z]|_|\$|[A-Za-z][0-9]/.test(name) || text.includes('`' + name + '`')
    || new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/\$/g, '\\$')}\\(`).test(text);
}
/**
 * Is *name* a capitalised compound written as prose — `DevTools`, `TypeScript`, `GraphQL`
 * without backticks or a call? Code-shaped by `isCodeShaped`, and in a short request it
 * still is; in a description or a report it is a product's name far more often than a
 * class's. "When React DevTools shows a Suspense boundary…" anchored `DevTools.js`, the
 * panel's root component, on it.
 */
function isProseName(name: string, text: string): boolean {
  return /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(name) && !text.includes('`' + name + '`')
    && !new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\(`).test(text);
}
/** Did *text* name this anchor's file by the form of what it wrote: a path, a record id, a code-shaped name? */
function namedByForm(a: TargetAnchor, text: string): boolean {
  if (a.kind === 'explicit_path' || a.kind === 'record') return true;
  return (a.kind === 'explicit_symbol' || a.kind === 'file_name') && !a.dependency && isCodeShaped(a.matched, text);
}

/** Was this anchor reached only through an English word that spells a symbol or a filename? */
function plainWordAnchor(a: TargetAnchor, text: string): boolean {
  return (a.kind === 'explicit_symbol' || a.kind === 'file_name') && !a.dependency && !isCodeShaped(a.matched, text);
}

/** Remove the anchors *drop* selects, with their files and the symbols they contributed. */
function dropAnchors(
  anchors: TargetAnchor[], claimed: Set<string>, namedSymbols: SymbolRow[], drop: (a: TargetAnchor) => boolean,
): void {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const a = anchors[i]!;
    if (!drop(a)) continue;
    anchors.splice(i, 1);
    claimed.delete(a.file);
    for (const s of a.symbols) {
      const k = namedSymbols.indexOf(s);
      if (k !== -1) namedSymbols.splice(k, 1);
    }
  }
}

/**
 * Code another project or a tool wrote, checked in: indexed, so a path that names it
 * resolves, but never ranked by words.
 *
 * The largest hand-written file in React, Next.js or Prettier is 339 KB.
 */
const MACHINE_DIRS = new Set(['compiled', 'vendored', 'third_party', 'third-party', '.yarn']);
const MACHINE_FILE = /\.(?:min|bundle)\.[cm]?js$/;
const MACHINE_SIZE = 1_000_000;

/** Up to this many candidate files are scored from their own rows; see `scoreFewFiles`. */
const WITHIN_DIRECT = 50;

/** Below this length a filename stem is too generic to treat as a deliberate reference. */
const MIN_STEM_LENGTH = 5;
const MAX_STEM_FANOUT = 3;

export interface SymbolRow {
  id: string;
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  exported: number;
}

export interface ImportRow {
  from_file: string;
  specifier: string;
  to_file: string | null;
  resolution: string;
  line: number;
}

export interface ReferenceRow {
  from_file: string;
  symbol_name: string;
  to_file: string | null;
  to_symbol_id: string | null;
  line: number;
  kind: string;
  confidence: string;
}

export interface NeighborhoodNode {
  path: string;
  /** 0 = the target itself; 1 = directly connected; 2 = connected to those. */
  distance: number;
  /** Why this file is in the neighbourhood, in the words used by the pack. */
  reasons: string[];
}

export interface Neighborhood {
  nodes: NeighborhoodNode[];
  imports: ImportRow[];
  references: ReferenceRow[];
}

/** Words too common in a task sentence to discriminate between files. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for',
  'from', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'up', 'use', 'using', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'why',
  'will', 'with', 'without', 'you', 'your', 'still', 'present', 'why', 'handle',
  'handling', 'modify', 'change', 'update', 'add', 'remove', 'fix', 'make',
]);

/**
 * Words that steer a conversation and never say what it is about.
 *
 * These words take no part in lexical scoring. Kept to words that do not name things in
 * code: "next" (Next.js), "right", "fine", "done", "continue" and "all" are left out,
 * and so are the workflow verbs, since "the test runner" is a subject. They still count
 * in an explicit name (`firstName`) and in a path, which are matched before lexical
 * scoring runs.
 */
export const STEERING_TERMS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'nope', 'okay', 'sure', 'great', 'nice', 'cool', 'perfect',
  'agreed', 'alright', 'lgtm', 'sounds', 'looks', 'seems', 'ahead', 'proceed', 'carry',
  'now', 'first', 'again', 'also', 'same', 'both', 'everything', 'lets', 'want', 'would',
  'please', 'thanks', 'thank',
]);

/** A record id in the shape the store gives them: REC-<number>, or REC-T<hex> for a derived record. */
export function isRecordId(name: string): boolean {
  return /^REC-(?:\d+|T[0-9a-f]{10})$/i.test(name);
}

/** What a request named that the repository does not hold, as the not-found reason says it. */
export function describeMissing(names: string[]): string {
  const records = names.filter(isRecordId);
  const paths = names.filter((n) => !isRecordId(n));
  return [
    ...(paths.length ? [`named a path the index does not hold: ${paths.join(', ')}`] : []),
    ...(records.length ? [`named a record the store does not hold: ${records.join(', ')}`] : []),
  ].join('; ');
}

/** Where a record's canonical file lives, relative to the repository root. */
export function recordFilePath(id: string): string {
  return `.strata/records/${id}.md`;
}

/** What a caller may tell the resolver beyond the request itself. */
export interface ResolveOptions {
  /** Files the developer is working on now; they break a tie between wording matches. */
  activeFiles?: string[];
}

export function tokenize(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.split(/[^A-Za-z0-9_]+/)) {
    const t = raw.trim().toLowerCase();
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Does *haystack* contain *term* as a whole word?
 *
 * Substring matching was the single largest source of wrong answers in the V0.1
 * resolver, and it failed in a way that looked like a ranking problem rather than a
 * matching one. "one", from the perfectly ordinary phrase "why one is not routed",
 * matches "comp**one**nts" — so every frontend file importing from `@/components/...`
 * scored, five times over, and buried the engine files the query was actually about.
 * "code" matches "de**code**Html" the same way.
 *
 * Identifiers and paths are split on camelCase humps and on the usual separators, then
 * compared whole. A term may be a prefix of a word or the other way round, so that
 * "alias" still finds `aliases` and vice versa — but only when the shorter side is a
 * real word on its own, never a fragment sitting in the middle of another.
 */
export function matchesWord(haystack: string, term: string): boolean {
  const words = haystack
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  for (const w of words) {
    if (w === term) return true;
    if (w.length >= 4 && term.length >= 4 && (w.startsWith(term) || term.startsWith(w))) return true;
  }
  return false;
}

/** One match: the file, what it adds to the plain sum, the place, and the match's weight. */
type ScoringHit = [file: string, amount: number, place: string, weight: number];

/** What `scoreFileMatches` reads once and reuses: see `CodeGraph.resolveTarget`. */
interface ScoringCache {
  hits: Map<string, ScoringHit[]>;
  machine?: Set<string>;
  symNames?: { name: string; lower: string }[];
  importsBySpecifier?: Map<string, Map<string, number>>;
  specNames?: { name: string; lower: string }[];
  refNames?: { name: string; lower: string }[];
}

export class CodeGraph {
  private db: StrataDatabase;
  /** Per-term matches, and what they are read from, for the `resolveTarget` call under way. */
  private scoring?: ScoringCache;

  constructor(db: StrataDatabase) {
    this.db = db;
  }

  public isIndexed(): boolean {
    const row = this.db.getRawDb().prepare('SELECT COUNT(*) c FROM code_files').get() as { c: number };
    return row.c > 0;
  }

  public fileCount(): number {
    return (this.db.getRawDb().prepare('SELECT COUNT(*) c FROM code_files').get() as { c: number }).c;
  }

  // ------------------------------------------------------------------ resolution

  /**
   * Work out what the query refers to.
   *
   * Explicit beats implicit, and — this is the part that used to be missing — explicit
   * means "named anywhere in the query", not "is the entire query". The old resolver
   * tested the whole string for an exact path and an exact symbol and then fell through
   * to word scoring, so the instant a path was written inside a sentence it stopped being
   * a path. Measured on the case that motivated this: the same file named on its own
   * resolved exactly, and named mid-sentence resolved lexically to five files, four of
   * them unrelated, which then pulled four unrelated subsystems into the neighbourhood
   * and pushed the commit that created the file out of the pack.
   *
   * So the query is scanned for references first. Anything it names outright becomes an
   * anchor, in this order of authority:
   *
   *   1. a path that exists in the index
   *   2. a symbol name that exists in the index, matched case-sensitively
   *   3. a word that is exactly an indexed file's name
   *   4. nothing named — fall back to scoring files by shared words
   *
   * A path the query asserts and the index does not hold is an error, not an invitation
   * to guess: the result is TARGET_NOT_FOUND and no word search runs.
   */
  public resolveTarget(query: string, hint?: TargetType, options: ResolveOptions = {}): ResolvedTarget {
    // One resolution scores the same words several times: per clause, for the within-clause
    // support check, and again to rank. Each term's matches are read once for all of them.
    // Scoped to the call, so a later refresh of the index is never answered from it.
    if (this.scoring) return this.resolveRequest(query, hint, options);
    this.scoring = { hits: new Map() };
    try {
      return this.resolveRequest(query, hint, options);
    } finally {
      this.scoring = undefined;
    }
  }

  private resolveRequest(query: string, hint?: TargetType, options: ResolveOptions = {}): ResolvedTarget {
    const clauses = splitClauses(query);
    if (clauses.length > MAX_COORDINATED_CLAUSES) return this.resolveClause(query, hint, true, options, true);

    /*
      A sentence that names nothing by its form describes behaviour, and is resolved like a
      report: one subject, ranked by its rarer words, where a plain word anchors only if the
      rest of the sentence agrees.

      The clause split made it worse, since each fragment anchored its own words. Ranked by
      rare words, the file the change was in came first or second for two of the three.
    */
    const describes = (parts: ResolvedTarget[]): boolean =>
      !hint && query.split(/\s+/).filter(Boolean).length >= DESCRIPTION_WORDS
      && !parts.some((p) => p.anchors.some((a) => namedByForm(a, query) && !isProseName(a.matched, query)));
    if (clauses.length < 2) {
      const whole = this.resolveClause(query, hint, true, options);
      return describes([whole]) ? this.resolveClause(query, hint, true, options, true) : whole;
    }

    /*
      A coordinated request names more than one thing, and resolving it as one
      string loses everything after the first anchor.

      "update the CORS policy in src/web/server.ts and keep the stock ledger
      behaviour" resolved to server.ts and stopped, because an explicit anchor
      ends the search — which is correct when the rest of the sentence describes
      the same file ("make cache lookups reliable in src/priceCacheService.ts")
      and wrong when it introduces a second subsystem.

      The difference is grammatical, not lexical, so the split is too: only a
      coordinating boundary with substantive text on both sides starts a second
      clause. A query without one resolves exactly as it did before.
    */
    const parts = clauses.map((c) => this.resolveClause(c, hint, false, options));
    if (describes(parts)) return this.resolveClause(query, hint, true, options, true);
    const merged: TargetAnchor[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();

    /*
      Explicit anchors from every clause first, in clause order, then the guesses — so a
      named file still outranks a well-scoring one.

      And once the request has named something outright, a sibling clause's guesses are
      admitted only when that clause picked a clear winner. A clause whose words match
      several files about equally is not naming a second subject; it is describing the
      first. Measured: "In backend/src/utils/trackUtils.ts; describe what the exported
      functions do; what inputs they handle" resolved the path exactly, then added four
      frontend components tied on "exported", "functions" and "inputs" — a quarter of the
      pack spent on files nobody asked about. A second subject that the words single out,
      like "…and keep the stock ledger behaviour", still gets in.
    */
    const namedOutright = parts.some((p) => p.anchors.some((a) => EXPLICIT_KINDS.has(a.kind)));
    // The same holds across clauses: "In the React Compiler, `src/…/CodegenReactiveFunction.ts`
    // gives…" splits at the comma, and "React" anchored `React.d.ts` from its own clause.
    const byForm = parts.some((p) => p.anchors.some((a) => namedByForm(a, query)));
    const supported = parts.map((p, i) => byForm && p.anchors.some((a) => plainWordAnchor(a, clauses[i]!))
      ? this.plainWordsSupported(clauses[i]!, p.anchors) : null);
    // Within the explicit anchors, a name given by its form leads, wherever its clause falls:
    // the primary target is the named path, not a filename the sentence's opening spelled.
    const tiers: ((a: TargetAnchor, clause: string) => boolean)[] = [
      (a, clause) => EXPLICIT_KINDS.has(a.kind) && namedByForm(a, clause),
      (a) => EXPLICIT_KINDS.has(a.kind),
      (a) => WEAK_KINDS.has(a.kind),
    ];
    for (const inTier of tiers) {
      const weak = inTier === tiers[2];
      for (const [i, part] of parts.entries()) {
        if (weak && namedOutright && part.confidence.level === 'LOW') continue;
        // Nor does a clause that resolved through plain words add its word-ranking guesses
        // beside a named path: "In the React Compiler" added `ReactFiberWorkLoop.js` and
        // `ReactFiberBeginWork.js`, whose commits displaced the named files' history.
        if (weak && supported[i]) continue;
        for (const anchor of part.anchors) {
          if (!inTier(anchor, clauses[i]!) || seen.has(anchor.file)) continue;
          if (supported[i] && plainWordAnchor(anchor, clauses[i]!) && !supported[i]!.has(anchor.file)) continue;
          if (weak && merged.length >= MAX_MERGED_ANCHORS) continue;
          seen.add(anchor.file);
          merged.push(anchor);
        }
      }
    }
    for (const part of parts) for (const u of part.unresolved) if (!unresolved.includes(u)) unresolved.push(u);

    // A clause asserting a file that does not exist is still an error, and it
    // does not become acceptable because a sibling clause resolved.
    if (!merged.length) {
      return unresolved.length
        ? { type: 'file', files: [], symbols: [], query, resolution: 'target_not_found', anchors: [], unresolved,
            confidence: assessConfidence('target_not_found', [], unresolved) }
        : { type: 'task', files: [], symbols: [], query, resolution: 'none', anchors: [], unresolved,
            confidence: assessConfidence('none', [], unresolved) };
    }

    const primary = merged[0]!;
    const primaryPart = parts.find((p) => p.anchors.some((a) => a.file === primary.file));
    const symbols = merged.flatMap((a) => a.symbols);
    return {
      type: primary.kind === 'explicit_symbol' ? 'symbol' : primary.kind === 'lexical' ? 'task' : 'file',
      files: merged.map((a) => a.file),
      symbols: symbols.length ? symbols : this.symbolsIn(primary.file),
      query,
      resolution: primaryPart?.resolution ?? 'lexical',
      anchors: merged,
      unresolved,
      // Graded from the merged anchors, so a request that names one file outright
      // and gestures at another is HIGH on the strength of the named one.
      confidence: assessConfidence(primaryPart?.resolution ?? 'lexical', merged, unresolved),
    };
  }

  /**
   * Resolve one clause. This is the whole of the original single-target pipeline.
   *
   * *entireRequest* is false for one clause of a coordinated request: a clause that is a
   * single word ("…the layout and page") is not a request that consists of a symbol name.
   *
   * *report* is true for a request too long to be an instruction (more than
   * `MAX_COORDINATED_CLAUSES` clauses): a pasted bug report or document. Its ordinary words
   * anchor only where its words agree, and a path it mentions that the index does not hold
   * is reported, not fatal.
   */
  private resolveClause(
    query: string, hint?: TargetType, entireRequest = true, options: ResolveOptions = {}, report = false,
  ): ResolvedTarget {
    const trimmed = query.trim();
    const references = extractReferences(trimmed);
    const wholeQuery = trimmed.replace(/\\/g, '/');

    const anchors: TargetAnchor[] = [];
    const unresolved: string[] = [];
    const claimed = new Set<string>();
    const add = (file: string, kind: AnchorKind, matched: string, symbols: SymbolRow[], plainWord = false): void => {
      if (claimed.has(file)) {
        const existing = anchors.find((a) => a.file === file);
        if (existing) for (const s of symbols) if (!existing.symbols.includes(s)) existing.symbols.push(s);
        return;
      }
      claimed.add(file);
      anchors.push({ file, kind, matched, symbols, ...(plainWord ? { plainWord: true } : {}) });
    };

    // 1. Paths. `--symbol` means the caller has already told us the query is not one.
    let exactPathHit = false;
    let suffixPathHit = false;
    if (hint !== 'symbol') {
      for (const ref of references) {
        if (ref.kind !== 'path') continue;
        const hit = this.filesForPath(ref.text);
        if (hit.files.length) {
          if (hit.how === 'exact') exactPathHit = true; else suffixPathHit = true;
          const files = hit.how === 'directory'
            ? this.rankWithinDirectory(hit.files, ref.text, trimmed)
            : hit.files;
          for (const f of files) add(f, 'explicit_path', ref.text, []);
        } else if (ref.assertsFile) {
          // A token with a real source extension is a claim about a file. A bare
          // "and/or" is not, and is dropped rather than reported as missing.
          unresolved.push(ref.text);
        }
      }
    }

    /*
      1b. A record, named by its id.

      Record files are deliberately kept out of the word index (every request that says
      "records" would match all of them by path), so an id is resolved here instead: a
      token that is exactly the id of a record in the store anchors its file.

      An id in the store's own shape that the store does not hold is named and missing,
      like a path that does not exist, and stops the pipeline the same way: "update REC-99"
      used to fall back to the words and land on copies of record files kept elsewhere in
      the repository.
    */
    if (hint !== 'symbol') {
      const ids = new Set(trimmed.match(/\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+\b/g) ?? []);
      for (const token of ids) {
        const row = this.db.getRawDb().prepare('SELECT id FROM records WHERE id = ? COLLATE NOCASE')
          .get(token) as { id: string } | undefined;
        if (row) add(recordFilePath(row.id), 'record', row.id, []);
        else if (isRecordId(token) && !unresolved.includes(token)) unresolved.push(token);
      }
    }

    /*
      An asserted path that does not exist stops the pipeline.

      Degrading to a word search here is the worst of both worlds: the caller gets a
      confident-looking pack about some other file, and no signal at all that the file
      they named was never found.

      Not in a report. A bug report mentions products and files outside the repository
      ("In Next.js with Cache Components…", measured on React's own tracker), and one such
      mention would discard the whole report.
    */
    if (!anchors.length && unresolved.length && !report) {
      return { type: 'file', files: [], symbols: [], query,
               resolution: 'target_not_found', anchors: [], unresolved,
               confidence: assessConfidence('target_not_found', [], unresolved) };
    }

    // 2. Symbols, matched case-sensitively so `YoutubeTrack` does not become
    //    `YouTubeTrack` in a different subsystem.
    const namedSymbols: SymbolRow[] = [];
    if (hint !== 'file') {
      /*
        A plain word names a symbol only weakly, and never a file-local one.

        A word that is not code-shaped, not in backticks and not the entire request is
        English first. It still anchors when it is the name of something a module
        exports, its public surface, but graded MEDIUM; a local declaration that shares
        its spelling is a coincidence and does not anchor at all. The word still counts
        in the lexical ranking below. A code-shaped name, a backticked one, a request
        that is just the name, and `--symbol` are explicit, and resolve exactly as
        before.
      */
      const hits = references
        .filter((ref) => ref.kind === 'identifier')
        .map((ref) => {
          const shaped = isCodeShaped(ref.text, trimmed);
          const asked = shaped || hint === 'symbol'
            || (entireRequest && references.length === 1 && ref.text === wholeQuery);
          const all = this.symbolsNamed(ref.text);
          return { ref, shaped, plain: !asked, syms: asked ? all : all.filter((s) => s.exported) };
        })
        // A stopword is never a name, however many test fixtures export a `then`.
        .filter((h) => !(h.plain && STOPWORDS.has(h.ref.text.toLowerCase())))
        .filter((h) => h.syms.length && new Set(h.syms.map((s) => s.file_path)).size <= MAX_SYMBOL_FANOUT);
      /*
        A word that looks like code outranks a word that merely spells a symbol.

        `generateDriftPlaylist` is unmistakably a reference; "call" is English that happens
        to be the name of a helper in a smoke-test script. Taken in query order, the
        English word came first: "Which files in this repository call
        generateDriftPlaylist" made the smoke test the primary target, ahead of the file
        that defines the function, and its surface displaced the function's own callers.

        So when a clause holds a code-shaped name that resolves — camelCase, snake_case, a
        digit, or written in backticks — the plain words beside it are prose. Where no such
        name resolves, a plain word that is exactly a symbol still anchors, as before.
      */
      const shapedHit = hits.some((h) => h.shaped);
      for (const { ref, syms, shaped, plain } of hits) {
        if (shapedHit && !shaped) continue;
        namedSymbols.push(...syms);
        for (const file of [...new Set(syms.map((s) => s.file_path))]) {
          add(file, 'explicit_symbol', ref.text, syms.filter((s) => s.file_path === file), plain);
        }
      }
    }

    // 2b. A package, named in a request about packages. The words are matched as typed,
    //     so `react-dom` and `@types/node` count, and case-insensitively, because npm
    //     names are lower case and "Phaser" in a sentence is still the package.
    if (hint !== 'symbol') {
      const words = trimmed.split(/\s+/).map((w) => stripPunctuation(w).toLowerCase()).filter(Boolean);
      if (words.some((w) => DEPENDENCY_INTENT.has(w))) {
        for (const word of new Set(words)) {
          if (DEPENDENCY_INTENT.has(word)) continue;
          const syms = this.dependenciesNamed(word);
          const manifests = [...new Set(syms.map((s) => s.file_path))];
          if (!manifests.length || manifests.length > MAX_SYMBOL_FANOUT) continue;
          namedSymbols.push(...syms);
          for (const file of manifests) {
            add(file, 'explicit_symbol', word, syms.filter((s) => s.file_path === file));
            const anchor = anchors.find((a) => a.file === file && a.matched === word);
            if (anchor) anchor.dependency = true;
          }
        }
      }
    }

    // 3. A bare word that is exactly a file's name. `trackCacheService` names a file as
    //    plainly as `trackCacheService.ts` does, and neither is a lexical guess.
    if (hint !== 'symbol') {
      for (const ref of references) {
        if (ref.kind !== 'identifier' || ref.text.length < MIN_STEM_LENGTH) continue;
        const files = this.filesNamed(ref.text);
        if (!files.length || files.length > MAX_STEM_FANOUT) continue;
        for (const f of files) add(f, 'file_name', ref.text, [], !isCodeShaped(ref.text, trimmed));
      }
    }

    // A name given by its form outweighs a plain word beside it; see `plainWordsSupported`.
    if (anchors.some((a) => namedByForm(a, trimmed)) && anchors.some((a) => plainWordAnchor(a, trimmed))) {
      const supported = this.plainWordsSupported(trimmed, anchors);
      dropAnchors(anchors, claimed, namedSymbols, (a) => plainWordAnchor(a, trimmed) && !supported.has(a.file));
    }

    // Task sentence terms: steering words take no part, they say how to proceed, not what with.
    const terms = tokenize(trimmed).filter((t) => !STEERING_TERMS.has(t));
    let lexical: { ranked: { file: string; score: number; floor: number }[]; scored: string[] } | null = null;
    const rankLexically = (): { ranked: { file: string; score: number; floor: number }[]; scored: string[] } => {
      if (lexical) return lexical;
      // A report is ranked by coverage of its rarer words (`rankFiles`).
      const ranked = report
        ? this.rankFiles(terms)
        : this.scoreFiles(terms).map(([file, sum]) => ({ file, score: sum, floor: sum }));
      const top = ranked[0]?.score ?? 0;
      // Keep only files close to the best match: a single shared token is noise.
      const scored = ranked.filter((r) => r.floor >= 2 && r.score >= top * 0.5).slice(0, 5).map((r) => r.file);
      return (lexical = { ranked, scored });
    };

    /*
      In a report, an ordinary word anchors only where the report's words agree.

      Measured on real bug reports in React, Next.js and Prettier: a report runs to dozens
      of ordinary words, and in a repository of thousands of files almost every one of them
      spells some file's name, some exported symbol or some package. "format" anchored
      `src/index.d.ts`, "React" `react.react-server.js`, "Input" two GraphQL fixtures, "set"
      `ReactInstanceMap.js`, "dependencies" a compiler fixture; "do not install
      dependencies" made "prettier" and "find" packages; a backticked `main` — the branch the
      reporter tried — anchored four files at HIGH. Each ended the search, and the word
      ranking that had the fix file first or second was never consulted.

      So in a report, an anchor reached through a word that is not code-shaped by its own
      form — a symbol, a filename or a package, backticked or not — stays only when its file
      is also among the files the report's words single out. A dropped word still counts in
      the ranking. Code-shaped names (`_debugInfo`, `trackUsedThenable`) and paths are
      untouched, and outside a report nothing here runs: a short request resolves exactly
      as before.
    */
    // Backticks alone do not make a word code here (the branch `main`); a call does (`forbidden()`).
    const unquoted = trimmed.replace(/`/g, ' ');
    const ordinary = (a: TargetAnchor): boolean =>
      (a.kind === 'explicit_symbol' || a.kind === 'file_name')
      && (!isCodeShaped(a.matched, unquoted) || isProseName(a.matched, trimmed));
    if (report && terms.length && anchors.some(ordinary)) {
      const supported = new Set(rankLexically().scored);
      dropAnchors(anchors, claimed, namedSymbols, (a) => ordinary(a) && !supported.has(a.file));
    }

    /*
      A bare word that happens to be a filename is the weakest kind of anchor, and it
      does not get to end the search.

      "backend/src/services/trackCacheService.ts" and "normalizeTrackKey" are unmistakable
      references — one carries a path and an extension, the other matches an identifier
      character for character. "schema" is an ordinary English word that is also the name
      of a file. Treating the three as equally decisive costs real results: the query
      "dataset schema" anchored on `schema.prisma` and stopped, dropping the dataset
      fixture the other half of the query was asking about.

      So a name-only resolution keeps its anchors at the front and *adds* the lexical
      hits behind them, rather than replacing them.
    */
    const nameOnly = anchors.length > 0 && anchors.every((a) => a.kind === 'file_name');
    if (anchors.length && !nameOnly) {
      const files = anchors.map((a) => a.file);
      const primary = anchors[0]!;
      const symbols = namedSymbols.length ? namedSymbols : this.symbolsIn(primary.file);
      const isWholeQuery = references.length === 1 && references[0]!.text === wholeQuery;
      let resolution: TargetResolution;
      if (primary.kind === 'explicit_path') {
        resolution = isWholeQuery
          ? (exactPathHit && !suffixPathHit ? 'exact_file' : 'path_suffix')
          : 'embedded_path';
      } else if (primary.kind === 'explicit_symbol') {
        resolution = isWholeQuery ? 'exact_symbol' : 'embedded_symbol';
      } else if (primary.kind === 'record') {
        resolution = 'named_record';
      } else {
        resolution = 'embedded_name';
      }
      const type: TargetType = primary.kind === 'explicit_symbol' ? 'symbol' : 'file';
      return { type, files, symbols, query, resolution, anchors, unresolved,
               confidence: assessConfidence(resolution, anchors, unresolved) };
    }

    // Task sentence: rank files by the request's words.
    if (!terms.length) {
      return anchors.length
        ? { type: 'file', files: anchors.map((a) => a.file), symbols: this.symbolsIn(anchors[0]!.file),
            query, resolution: 'embedded_name', anchors, unresolved,
            confidence: assessConfidence('embedded_name', anchors, unresolved) }
        : { type: 'task', files: [], symbols: [], query, resolution: 'none', anchors: [], unresolved,
            confidence: assessConfidence('none', [], unresolved) };
    }

    const { ranked, scored } = rankLexically();
    const top = ranked[0]?.score ?? 0;

    /*
      A tie between wording matches is broken by the developer's current work.

      A request that names nothing is matched by its words, and words tie: a request in a
      conversation about work under way ("tighten the limitation we just added") shares a
      word or two with several files, and the one being changed is the one meant far more
      often than chance. When the words leave no clear winner, and exactly one of
      the files they match is in the working tree or in recent commits — or one such file
      outscores the others twice over — that file is the target, alone, graded MEDIUM and
      marked as chosen this way. Otherwise nothing changes: a clear winner by the words
      stands, and so does a tie with no active file in it. The active file must still
      match on the scorer's own floor; current work never makes a file match.
    */
    const clear = scored.length === 1 || top >= (ranked[1]?.score ?? 0) * 2;
    if (!clear && !nameOnly && options.activeFiles?.length) {
      const active = new Set(options.activeFiles.map((f) => f.replace(/\\/g, '/')));
      const inWork = ranked.filter((r) => r.floor >= 2 && active.has(r.file));
      const lead = inWork[0];
      if (lead && (inWork.length === 1 || lead.score >= inWork[1]!.score * 2)) {
        const anchor: TargetAnchor = { file: lead.file, kind: 'lexical', matched: trimmed, symbols: [], active: true };
        return {
          type: 'task', files: [lead.file], symbols: [], query, resolution: 'lexical', anchors: [anchor], unresolved,
          confidence: assessConfidence('lexical', [anchor], unresolved),
        };
      }
    }

    // Lexical hits are anchors too, and are labelled as the guesses they are so that
    // history ranking can tell a named target from a well-scoring one.
    for (const f of scored) add(f, 'lexical', trimmed, []);
    if (!anchors.length) {
      return { type: 'task', files: [], symbols: [], query, resolution: 'none',
               anchors: [], unresolved, confidence: assessConfidence('none', [], unresolved) };
    }

    const files = anchors.map((a) => a.file);
    const resolution: TargetResolution = nameOnly ? 'embedded_name' : 'lexical';
    return {
      type: nameOnly ? 'file' : 'task',
      files,
      symbols: nameOnly ? this.symbolsIn(files[0]!) : [],
      query,
      resolution,
      anchors,
      unresolved,
      confidence: assessConfidence(resolution, anchors, unresolved, {
        top: ranked[0]?.score ?? 0,
        second: ranked[1]?.score ?? 0,
        survivors: scored.length,
      }),
    };
  }

  /**
   * Score files by how many query terms their path, symbols, imports and references match.
   *
   * The one lexical scorer in the resolver. *within*, when given, restricts scoring to those
   * files; it narrows the candidates and never changes how a candidate is scored.
   */
  private scoreFiles(terms: string[], within?: Set<string>): [string, number][] {
    return this.scoreFileMatches(terms, within)
      .map((m): [string, number] => [m.file, m.sum])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  /**
   * Rank files for a request that names nothing: by how many of its words each file
   * matches, weighted by how rare each word is in the repository.
   *
   * The plain sum counts every matching row, so it rewards volume. Measured on React and
   * Prettier with real bug reports: `flow-typed/environments/html.js` scored 687 to the
   * fix file's 398 because hundreds of its declarations contain "hidden", "style" or
   * "span", and a word that names a thousand files counted as much as "thenable", which
   * names a handful. Here a word counts once per file in each place it can match — the
   * path, a declaration, an import, a reference — at that place's strongest weight, and
   * the total is scaled by `ln(1 + N / df)`. Five hundred declarations containing "style"
   * count once; a word in both the path and a declaration (`src/pdf/render.ts` declaring
   * `invoicePdf`) still counts twice, because the two places agree.
   * *floor* is the plain sum, unchanged: whether a file matches at all is decided exactly
   * as before ("where is call defined" still reaches the script that declares and calls
   * `call`); only the order among the files that do is new.
   */
  private rankFiles(terms: string[]): { file: string; score: number; floor: number }[] {
    const total = this.fileCount() || 1;
    const matches = this.scoreFileMatches(terms);
    const df = new Map<string, number>();
    for (const m of matches) for (const t of m.best.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return matches
      .map((m) => {
        let score = 0;
        for (const [t, places] of m.best) {
          let w = 0;
          for (const v of places.values()) w += v;
          score += w * Math.log(1 + total / (df.get(t) ?? 1));
        }
        return { file: m.file, score, floor: m.sum };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  }

  /**
   * Of the plain-word anchors in *anchors*, the files that at least two of *text*'s words
   * match: a request that names something by its form still meant a second subject it
   * describes in English, but not every file one of its words happens to spell.
   *
   * Each matched one word of its clause. "understand tagTypes and the reorder policy" still
   * anchors `reorderPolicy.ts`, which matches two.
   */
  private plainWordsSupported(text: string, anchors: TargetAnchor[]): Set<string> {
    const files = new Set(anchors.filter((a) => plainWordAnchor(a, text)).map((a) => a.file));
    const terms = tokenize(text).filter((t) => !STEERING_TERMS.has(t));
    return new Set(this.scoreFileMatches(terms, files).filter((m) => m.best.size >= 2).map((m) => m.file));
  }

  /** Indexed files that are vendored, bundled or generated; see `MACHINE_DIRS`. */
  private machineAuthored(): Set<string> {
    // SQL narrows the candidates; the exact rule is applied to what comes back.
    const like = [...MACHINE_DIRS].map((d) => `path LIKE '%${d}/%'`).join(' OR ');
    const rows = this.db.getRawDb().prepare(
      `SELECT path, size_bytes FROM code_files WHERE size_bytes > ? OR ${like} OR path LIKE '%.min.%' OR path LIKE '%.bundle.%'`,
    ).all(MACHINE_SIZE) as { path: string; size_bytes: number | null }[];
    return new Set(rows.filter((r) =>
      (r.size_bytes ?? 0) > MACHINE_SIZE || MACHINE_FILE.test(r.path)
      || r.path.split('/').slice(0, -1).some((p) => MACHINE_DIRS.has(p))).map((r) => r.path));
  }

  /** Every file a term matches: the plain sum, and per term the strongest weight in each place. */
  private scoreFileMatches(
    terms: string[], within?: Set<string>,
  ): { file: string; sum: number; best: Map<string, Map<string, number>> }[] {
    const raw = this.db.getRawDb();
    if (within && within.size <= WITHIN_DIRECT) return this.scoreFewFiles(terms, within);
    const scores = new Map<string, { file: string; sum: number; best: Map<string, Map<string, number>> }>();
    // Outside a `resolveTarget` call nothing is shared, as before.
    const cache: ScoringCache = this.scoring ?? { hits: new Map() };
    const machine = cache.machine ??= this.machineAuthored();
    let term = '';
    // A term's matches are found once, before *within* and the machine-authored files
    // narrow them, and then credited to each file exactly as they were found.
    let found: ScoringHit[] = [];
    // *weight* is one match's weight; *amount* may count several matches of that weight.
    const bump = (file: string, amount: number, place: string, weight = amount): void => {
      found.push([file, amount, place, weight]);
    };
    const credit = ([file, amount, place, weight]: ScoringHit): void => {
      if (within && !within.has(file)) return;
      if (machine.has(file)) return;
      let entry = scores.get(file);
      if (!entry) scores.set(file, entry = { file, sum: 0, best: new Map() });
      entry.sum += amount;
      let places = entry.best.get(term);
      if (!places) entry.best.set(term, places = new Map());
      if (weight > (places.get(place) ?? 0)) places.set(place, weight);
    };

    /*
      Declarations, imports and references are matched by their distinct names in memory,
      and counted per file without returning every row.

      A `LIKE '%term%'` scan per word returns every matching row to JavaScript. Measured on
      VS Code with a 95-word report: 162,046 declaration rows (6.3 s), 100,367 import rows
      (4.1 s), and on references — 3.2 million rows — most of a 53 s hook. The distinct
      names are far fewer and are read once per call. Each file gains exactly what the
      row-by-row scan gave it.
    */
    const CHUNK = 500;
    const slots = Array(CHUNK).fill('?').join(',');
    const distinct = (sql: string): { name: string; lower: string }[] =>
      (raw.prepare(sql).all() as { name: string }[]).map((r) => ({ name: r.name, lower: r.name.toLowerCase() }));
    const matching = (names: { name: string; lower: string }[]): string[] =>
      names.filter(({ name, lower }) => lower.includes(term) && matchesWord(name, term)).map((r) => r.name);
    // One prepared statement per table serves every chunk, padded with a name nothing has.
    const chunks = (names: string[]): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < names.length; i += CHUNK) {
        const chunk = names.slice(i, i + CHUNK);
        while (chunk.length < CHUNK) chunk.push('\u0000');
        out.push(chunk);
      }
      return out;
    };
    const symCounts = raw.prepare(
      `SELECT file_path, COUNT(*) n, SUM(exported != 0) ex FROM code_symbols WHERE name IN (${slots}) GROUP BY file_path`,
    );
    const refCounts = raw.prepare(
      `SELECT from_file, COUNT(DISTINCT symbol_name) c FROM code_references WHERE symbol_name IN (${slots}) GROUP BY from_file`,
    );

    // SQL does the cheap prefilter with LIKE; `matchesWord` decides. Doing the
    // boundary check in SQL would mean a scan and a UDF for no gain.
    for (term of terms) {
      const known = cache.hits.get(term);
      if (known) {
        known.forEach(credit);
        continue;
      }
      found = [];
      for (const row of raw.prepare(
        `SELECT path FROM code_files WHERE LOWER(path) LIKE ?`
      ).all(`%${term}%`) as { path: string }[]) {
        if (matchesWord(row.path, term)) bump(row.path, 3, 'path');
      }
      // An exported declaration weighs 2, a local one 1.
      cache.symNames ??= distinct('SELECT DISTINCT name FROM code_symbols');
      for (const chunk of chunks(matching(cache.symNames))) {
        for (const row of symCounts.all(...chunk) as { file_path: string; n: number; ex: number }[]) {
          bump(row.file_path, row.ex * 2 + (row.n - row.ex), 'symbol', row.ex ? 2 : 1);
        }
      }
      // What a file *uses* names its subject as surely as what it declares. `server.ts`
      // owns the CORS configuration but declares no symbol containing the word: it
      // imports the `cors` package and calls it. Scoring only paths and declarations
      // misses the file the query is actually about, which is the failure this whole
      // engine exists to avoid.
      // Specifiers have no index, so the imports are grouped by specifier once per call.
      if (!cache.importsBySpecifier) {
        const importsBySpecifier = cache.importsBySpecifier = new Map<string, Map<string, number>>();
        for (const row of raw.prepare('SELECT from_file, specifier FROM code_imports').all() as
            { from_file: string; specifier: string }[]) {
          let files = importsBySpecifier.get(row.specifier);
          if (!files) importsBySpecifier.set(row.specifier, files = new Map());
          files.set(row.from_file, (files.get(row.from_file) ?? 0) + 1);
        }
        cache.specNames = [...importsBySpecifier.keys()].map((name) => ({ name, lower: name.toLowerCase() }));
      }
      for (const spec of matching(cache.specNames!)) {
        for (const [file, n] of cache.importsBySpecifier.get(spec)!) bump(file, n * 2, 'import', 2);
      }
      // A file gains one per distinct matching name it uses, through `idx_code_refs_name`.
      cache.refNames ??= distinct('SELECT DISTINCT symbol_name AS name FROM code_references');
      for (const chunk of chunks(matching(cache.refNames))) {
        for (const row of refCounts.all(...chunk) as { from_file: string; c: number }[]) {
          bump(row.from_file, row.c, 'reference', 1);
        }
      }
      cache.hits.set(term, found);
      found.forEach(credit);
    }
    return [...scores.values()];
  }

  /**
   * `scoreFileMatches` for a handful of files, read from those files' own rows.
   *
   * The repository-wide pass matches every term against every distinct name and then
   * keeps the files in *within*; the support check asks about two or three files, and on
   * Next.js that cost 430 ms of a resolution. Each file gains exactly what the wide pass
   * gives it: a path match weighs 3, a declaration 2 if exported and 1 if not, an import
   * row 2, and each distinct name it references 1.
   */
  private scoreFewFiles(
    terms: string[], within: Set<string>,
  ): { file: string; sum: number; best: Map<string, Map<string, number>> }[] {
    const raw = this.db.getRawDb();
    const machine = this.scoring ? (this.scoring.machine ??= this.machineAuthored()) : this.machineAuthored();
    const files = [...within].filter((f) => !machine.has(f));
    const scores: { file: string; sum: number; best: Map<string, Map<string, number>> }[] = [];
    const symbols = raw.prepare('SELECT name, exported FROM code_symbols WHERE file_path = ?');
    const imports = raw.prepare('SELECT specifier FROM code_imports WHERE from_file = ?');
    const references = raw.prepare('SELECT DISTINCT symbol_name AS name FROM code_references WHERE from_file = ?');
    const known = raw.prepare('SELECT 1 FROM code_files WHERE path = ?');
    const hit = (name: string, term: string): boolean => name.toLowerCase().includes(term) && matchesWord(name, term);
    for (const file of files) {
      if (!known.get(file)) continue;
      const syms = symbols.all(file) as { name: string; exported: number }[];
      const specs = (imports.all(file) as { specifier: string }[]).map((r) => r.specifier);
      const refs = (references.all(file) as { name: string }[]).map((r) => r.name);
      let entry: { file: string; sum: number; best: Map<string, Map<string, number>> } | undefined;
      const bump = (term: string, amount: number, place: string, weight: number): void => {
        if (!entry) scores.push(entry = { file, sum: 0, best: new Map() });
        entry.sum += amount;
        let places = entry.best.get(term);
        if (!places) entry.best.set(term, places = new Map());
        if (weight > (places.get(place) ?? 0)) places.set(place, weight);
      };
      for (const term of terms) {
        if (hit(file, term)) bump(term, 3, 'path', 3);
        const matched = syms.filter((s) => hit(s.name, term));
        if (matched.length) {
          const ex = matched.filter((s) => s.exported !== 0).length;
          bump(term, ex * 2 + (matched.length - ex), 'symbol', ex ? 2 : 1);
        }
        const used = specs.filter((s) => hit(s, term)).length;
        if (used) bump(term, used * 2, 'import', 2);
        const named = refs.filter((r) => hit(r, term)).length;
        if (named) bump(term, named, 'reference', 1);
      }
    }
    return scores;
  }

  /**
   * The files of a named directory that the rest of the request is about.
   *
   * A directory keeps its scope — nothing outside it becomes a target — but not every file
   * inside it is equally meant. Selection used to be the five shortest paths, which made
   * the target set a property of filename length: "four sequencing engine implementations
   * under backend/src/utils/" resolved to trackUtils, flowMetrics and errorHandler ahead of
   * two of the four engines, and the engine-dispatch evidence never reached the pack.
   *
   * So the directory's files are ranked by the same lexical scorer the resolver already
   * uses, against the request's other words. The directory's own path words are left out,
   * since every file inside it matches those equally and they say nothing about which one
   * is meant.
   *
   * One signal is added, at the scorer's lowest weight: what *uses* a file. The scorer
   * already credits a file for what it imports, because what a file uses names its
   * subject; the converse holds for a file's role. Measured on that request, the request's
   * words reached only the two engines whose alias exports happen to contain "Engine";
   * all four engines are imported by the engine service and the engine evaluation
   * scripts, and nothing else in the directory is imported by more than one file whose
   * name matches the request.
   *
   * Survival is the scorer's absolute floor, without its relative cut. The relative cut —
   * "within half of the best" — exists to tell a clear winner from also-rans among
   * guesses across the whole repository. Inside a directory the request named, scope is
   * already certain, and several files can be meant at once. When no word discriminates,
   * the previous order stands.
   */
  private rankWithinDirectory(files: string[], directoryRef: string, clause: string): string[] {
    const own = new Set(tokenize(directoryRef));
    const terms = tokenize(clause).filter((t) => !own.has(t));
    if (!terms.length) return files.slice(0, MAX_DIRECTORY_FILES);

    const scores = new Map(this.scoreFiles(terms, new Set(files)));
    for (const file of files) {
      const users = new Set(this.importersOf(file).map((r) => r.from_file));
      let named = 0;
      for (const user of users) if (terms.some((t) => matchesWord(user, t))) named++;
      if (named) scores.set(file, (scores.get(file) ?? 0) + named);
    }
    const survivors = [...scores.entries()]
      .filter(([, s]) => s >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([f]) => f);
    return (survivors.length ? survivors : files).slice(0, MAX_DIRECTORY_FILES);
  }

  /**
   * Files for one path reference.
   *
   * Suffix matching is anchored to a path separator. `'%' + p` would let `config.ts`
   * match `oldconfig.ts`, which is a different file with a similar name — precisely the
   * class of near-miss this resolver exists to rule out.
   */
  private filesForPath(reference: string): { files: string[]; how: 'exact' | 'suffix' | 'directory' } {
    const raw = this.db.getRawDb();
    const normalized = reference.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) return { files: [], how: 'exact' };

    const exact = raw.prepare('SELECT path FROM code_files WHERE path = ?').get(normalized) as
      { path: string } | undefined;
    if (exact) return { files: [exact.path], how: 'exact' };

    const suffix = raw.prepare(
      `SELECT path FROM code_files WHERE path LIKE ? ORDER BY LENGTH(path), path LIMIT 5`
    ).all('%/' + normalized) as { path: string }[];
    if (suffix.length) return { files: suffix.map((r) => r.path), how: 'suffix' };

    // A directory reference: "backend/src/services" names the files under it. All of them
    // are returned; which ones the request means is decided by `rankWithinDirectory`.
    if (normalized.includes('/')) {
      const under = raw.prepare(
        `SELECT path FROM code_files WHERE path = ? OR path LIKE ? ORDER BY LENGTH(path), path LIMIT ?`
      ).all(normalized, normalized + '/%', MAX_DIRECTORY_CANDIDATES) as { path: string }[];
      if (under.length) return { files: under.map((r) => r.path), how: 'directory' };
    }
    return { files: [], how: 'exact' };
  }

  /**
   * Every indexed file a directory reference names, or null when the reference is not a
   * directory. Read-only: resolution is unchanged, and this only lets a caller say which
   * of a directory's files the resolver's ceiling left out.
   */
  public directoryFiles(reference: string): string[] | null {
    const hit = this.filesForPath(reference);
    return hit.how === 'directory' ? hit.files : null;
  }

  /** Symbols with exactly this name. Case-sensitive: the case *is* the name. */
  public symbolsNamed(name: string): SymbolRow[] {
    return this.db.getRawDb().prepare(
      `SELECT * FROM code_symbols WHERE name = ? ORDER BY exported DESC, file_path LIMIT 10`
    ).all(name) as unknown as SymbolRow[];
  }

  /** Dependencies called *name* (npm names are lower case), across every manifest. */
  public dependenciesNamed(name: string): SymbolRow[] {
    return this.db.getRawDb().prepare(
      `SELECT * FROM code_symbols WHERE kind = 'dependency' AND name = ? ORDER BY file_path LIMIT 10`
    ).all(name.toLowerCase()) as unknown as SymbolRow[];
  }

  /** Files whose basename, extension removed, is exactly this word. */
  public filesNamed(stem: string): string[] {
    const wanted = stem.toLowerCase();
    const rows = this.db.getRawDb().prepare(
      `SELECT path FROM code_files WHERE LOWER(path) LIKE ?`
    ).all('%' + wanted + '.%') as { path: string }[];
    return rows
      .filter((r) => {
        const base = r.path.split('/').pop() ?? r.path;
        return base.slice(0, base.indexOf('.') === -1 ? base.length : base.indexOf('.'))
          .toLowerCase() === wanted;
      })
      .map((r) => r.path)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  /**
   * How the index holds one file: its language, and how many declarations the parser
   * took from it. Null when the file is not in the index. `data` files are registered by
   * path only, so they never have declarations.
   */
  public fileInfo(filePath: string): { language: string; declarations: number; exported: number } | null {
    const raw = this.db.getRawDb();
    const row = raw.prepare('SELECT language FROM code_files WHERE path = ?').get(filePath) as
      { language: string } | undefined;
    if (!row) return null;
    const counts = raw.prepare(
      'SELECT COUNT(*) n, COALESCE(SUM(exported), 0) e FROM code_symbols WHERE file_path = ?'
    ).get(filePath) as { n: number; e: number };
    return { language: row.language, declarations: counts.n, exported: counts.e };
  }

  public symbolsIn(filePath: string): SymbolRow[] {
    return this.db.getRawDb().prepare(
      `SELECT * FROM code_symbols WHERE file_path = ? ORDER BY exported DESC, start_line`
    ).all(filePath) as unknown as SymbolRow[];
  }

  // ------------------------------------------------------------------ expansion

  public importsFrom(filePath: string): ImportRow[] {
    return this.db.getRawDb().prepare(
      `SELECT from_file, specifier, to_file, resolution, line FROM code_imports
       WHERE from_file = ? ORDER BY line`
    ).all(filePath) as unknown as ImportRow[];
  }

  public importersOf(filePath: string): ImportRow[] {
    return this.db.getRawDb().prepare(
      `SELECT from_file, specifier, to_file, resolution, line FROM code_imports
       WHERE to_file = ? ORDER BY from_file`
    ).all(filePath) as unknown as ImportRow[];
  }

  /** References *into* a file: who uses what this file defines. */
  public referencesTo(filePath: string): ReferenceRow[] {
    return this.db.getRawDb().prepare(
      `SELECT from_file, symbol_name, to_file, to_symbol_id, line, kind, confidence
       FROM code_references WHERE to_file = ? AND from_file <> ? ORDER BY from_file, line`
    ).all(filePath, filePath) as unknown as ReferenceRow[];
  }

  /** References to a specific symbol name that resolve into *definingFile*. */
  public referencesToSymbol(name: string, definingFile: string): ReferenceRow[] {
    return this.db.getRawDb().prepare(
      `SELECT from_file, symbol_name, to_file, to_symbol_id, line, kind, confidence
       FROM code_references
       WHERE symbol_name = ? AND to_file = ? AND from_file <> ?
       ORDER BY from_file, line`
    ).all(name, definingFile, definingFile) as unknown as ReferenceRow[];
  }

  /**
   * Breadth-first walk out from *seeds* to the given depth.
   *
   * Distance 1 is everything directly wired to a seed — what it imports, what imports it,
   * what references it. Distance 2 repeats that once more and is off by default, because
   * the second ring grows fast and the point of the engine is a small neighbourhood.
   */
  public expand(seeds: string[], depth: number, maxNodes = 40): Neighborhood {
    const nodes = new Map<string, NeighborhoodNode>();
    const imports: ImportRow[] = [];
    const references: ReferenceRow[] = [];

    for (const seed of seeds) {
      nodes.set(seed, { path: seed, distance: 0, reasons: ['query target'] });
    }

    let frontier = [...seeds];
    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const imp of this.importsFrom(current)) {
          imports.push(imp);
          if (imp.to_file) {
            this.touch(nodes, imp.to_file, d, `imported by ${current}`, next, maxNodes);
          }
        }
        for (const imp of this.importersOf(current)) {
          imports.push(imp);
          this.touch(nodes, imp.from_file, d, `imports ${current}`, next, maxNodes);
        }
        for (const ref of this.referencesTo(current)) {
          references.push(ref);
          this.touch(nodes, ref.from_file, d, `references ${ref.symbol_name}`, next, maxNodes);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    return {
      nodes: [...nodes.values()].sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path)),
      imports: dedupeImports(imports),
      references,
    };
  }

  private touch(
    nodes: Map<string, NeighborhoodNode>, path: string, distance: number,
    reason: string, next: string[], maxNodes: number,
  ): void {
    const existing = nodes.get(path);
    if (existing) {
      if (!existing.reasons.includes(reason) && existing.reasons.length < 4) {
        existing.reasons.push(reason);
      }
      return;
    }
    if (nodes.size >= maxNodes) return;
    nodes.set(path, { path, distance, reasons: [reason] });
    next.push(path);
  }

  // ------------------------------------------------------------------ history links

  /** Commits that touched any of *files*, most recent first, with the files they hit. */
  public commitsForFiles(files: string[], limit = 25): { hash: string; authored_at: number; files: string[] }[] {
    if (!files.length) return [];
    const raw = this.db.getRawDb();
    const placeholders = files.map(() => '?').join(',');
    const rows = raw.prepare(
      `SELECT commit_hash, authored_at, file_path FROM code_file_commits
       WHERE file_path IN (${placeholders})`
    ).all(...files) as { commit_hash: string; authored_at: number; file_path: string }[];

    const byCommit = new Map<string, { hash: string; authored_at: number; files: string[] }>();
    for (const row of rows) {
      let entry = byCommit.get(row.commit_hash);
      if (!entry) {
        entry = { hash: row.commit_hash, authored_at: row.authored_at, files: [] };
        byCommit.set(row.commit_hash, entry);
      }
      if (!entry.files.includes(row.file_path)) entry.files.push(row.file_path);
    }
    return [...byCommit.values()]
      .sort((a, b) => b.authored_at - a.authored_at)
      .slice(0, limit);
  }

  /**
   * Commits whose *message* agrees with the query's words.
   *
   * The weakest signal in the system, and it exists so that the strongest one can be shown
   * to beat it. History ranking claims that a commit which only shares vocabulary cannot
   * displace one that changed the target; without lexical candidates in the pool that
   * claim is untestable, and this is the only thing this method is for. Whole-word
   * matching, for the same reason as everywhere else: "one" must not match "components".
   */
  public commitsMatchingTerms(terms: string[], limit = 8): { hash: string; authored_at: number; files: string[] }[] {
    if (!terms.length) return [];
    const raw = this.db.getRawDb();
    const hits = new Map<string, { hash: string; authored_at: number; files: string[]; score: number }>();
    for (const term of terms) {
      const rows = raw.prepare(
        `SELECT hash, authored_at, message, changed_files FROM git_commits_cache
         WHERE LOWER(message) LIKE ?`
      ).all(`%${term}%`) as
        { hash: string; authored_at: number; message: string; changed_files: string }[];
      for (const row of rows) {
        if (!matchesWord(row.message, term)) continue;
        const existing = hits.get(row.hash);
        if (existing) { existing.score++; continue; }
        let files: string[] = [];
        try { files = JSON.parse(row.changed_files) as string[]; } catch { files = []; }
        hits.set(row.hash, { hash: row.hash, authored_at: row.authored_at, files, score: 1 });
      }
    }
    return [...hits.values()]
      .sort((a, b) => b.score - a.score || b.authored_at - a.authored_at || a.hash.localeCompare(b.hash))
      .slice(0, limit)
      .map(({ hash, authored_at, files }) => ({ hash, authored_at, files }));
  }
}

function dedupeImports(rows: ImportRow[]): ImportRow[] {
  const seen = new Set<string>();
  const out: ImportRow[] = [];
  for (const r of rows) {
    const key = `${r.from_file}|${r.specifier}|${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
