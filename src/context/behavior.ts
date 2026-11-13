/**
 * Current behaviour: what the target does *now*, and who calls it.
 *
 * Why this exists
 * ---------------
 * Measured, not assumed. In the last run the agent received a pack rich in history and
 * then spent its next five tool calls on:
 *
 *     cat -n backend/src/services/trackCacheService.ts
 *     cat -n backend/prisma/schema.prisma
 *     grep -rn "getOrAnalyzeTrack|normalizeTrackKey|videoId" backend/
 *     grep -n "getOrAnalyzeTrack" -A 20 backend/src/controllers/engineController.ts
 *     grep -rn "getOrAnalyzeTrack" backend/scripts/*.ts
 *
 * Every one of those is a question the index could already answer. The pack named the
 * files that reference the target and did not say *where* — so the agent, holding a list
 * of filenames, went and grepped for line numbers Strata had already stored.
 *
 * What it does and does not do
 * ----------------------------
 * It quotes. Signature lines come off disk at the line the index recorded; call sites come
 * from `code_references`, which is only populated when the syntax binds the name. Nothing
 * here describes what a function means, because a description of behaviour is an
 * interpretation and the file itself is right there.
 *
 * It reads the working tree rather than HEAD, deliberately. "Current" for an agent about
 * to edit a file means the bytes it is about to edit, not the last committed version of
 * them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeGraph } from '../code/graph.js';
import { CallSite, CurrentBehavior } from './pack.js';

/** Signatures quoted per file. Beyond this the file is better opened than excerpted. */
const MAX_SIGNATURES = 8;
/** Continuation lines followed when a signature wraps. */
const MAX_SIGNATURE_LINES = 3;
const MAX_CALL_SITES = 10;
/** Anchors whose call sites are gathered. More than the two whose signatures are quoted:
 *  a line reference is cheap, and a request naming several files needs each one's callers. */
const MAX_CALL_SITE_ANCHORS = 5;

/**
 * The limits a human view reads with instead.
 *
 * A developer asking what a module does now wants its module-level declarations too —
 * a constant like an origin allow-list is often exactly the thing — and every file of a
 * named directory, not the first two. Non-exported declarations are marked as such.
 */
export interface BehaviorLimits { files: number; signatures: number; callSites: number; callSiteAnchors: number; declarations: boolean }
export const AGENT: BehaviorLimits = {
  files: 2, signatures: MAX_SIGNATURES, callSites: MAX_CALL_SITES, callSiteAnchors: MAX_CALL_SITE_ANCHORS, declarations: false,
};

/**
 * The number of lines in a file, given its text split on line breaks.
 *
 * Splitting on line breaks yields one element more than there are breaks, so a file that
 * ends in a newline — nearly every source file — has an empty last element that is not a
 * line. Counting it reported every such file one line long, under a VERIFIED label. A
 * file without a final newline has no empty last element, and its last line counts; an
 * empty file has none.
 */
export function lineCount(lines: string[]): number {
  return lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

export class BehaviorReader {
  private graph: CodeGraph;
  private repoRoot?: string;

  constructor(graph: CodeGraph, repoRoot?: string) {
    this.graph = graph;
    this.repoRoot = repoRoot;
  }

  /**
   * The exported surface of each anchor file, quoted from disk.
   *
   * Exported symbols only: a file's private helpers are its own business, and the thing an
   * agent needs before editing is the surface other code is holding on to.
   */
  public describe(
    anchorFiles: string[], options: { named?: string[]; limits?: BehaviorLimits } = {},
  ): CurrentBehavior[] {
    if (!this.repoRoot) return [];
    const out: CurrentBehavior[] = [];
    const named = new Set(options.named ?? []);
    const limits = options.limits ?? AGENT;

    for (const file of anchorFiles.slice(0, limits.files)) {
      const lines = this.readLines(file);
      if (!lines) continue;

      /*
        A symbol the request named is quoted first.

        Signatures are listed in file order and the budget trims them from the end, keeping
        one per file. Asked about `generateDriftPlaylist`, defined at line 160, the one
        signature that survived was a type declared at line 8 — the definition of the
        function the question was about was the first thing cut.
      */
      // A dependency the request named is quoted too: it is never exported, and its line
      // ("phaser": "^3.90.0") is the current state an upgrade starts from.
      const symbols = this.graph.symbolsIn(file)
        .filter((s) => s.exported || limits.declarations || (s.kind === 'dependency' && named.has(s.name)))
        .map((s, i) => ({ s, i }))
        .sort((a, b) => Number(!named.has(a.s.name)) - Number(!named.has(b.s.name))
          || (limits.declarations ? Number(!a.s.exported) - Number(!b.s.exported) : 0) || a.i - b.i)
        .map((x) => x.s);
      const signatures: CurrentBehavior['signatures'] = [];
      for (const sym of symbols.slice(0, limits.signatures)) {
        const text = this.signatureAt(lines, sym.start_line);
        if (!text) continue;
        signatures.push({
          name: sym.name, kind: sym.kind, line: sym.start_line, text,
          ...(sym.exported ? {} : { exported: false }),
        });
      }
      if (!signatures.length && !symbols.length) continue;

      out.push({
        file,
        signatures,
        signaturesOmitted: Math.max(0, symbols.length - signatures.length),
        totalLines: lineCount(lines),
        // Exact bytes from the file on disk. Nothing is summarised.
        provenance: 'VERIFIED',
      });
    }
    return out;
  }

  /**
   * Where the target's exported names are actually used, most relevant first.
   *
   * `file:line` rather than a filename, because a filename is a search instruction and a
   * line number is an answer. Only references the indexer could bind are here; an unbound
   * identifier that happens to share a name is not a call site and is not listed.
   *
   * The order is a priority, and the budget relies on it
   * ---------------------------------------------------
   * The list used to be sorted by file name, and the budget trims it from the end, so which
   * call sites survived was decided by the alphabet. Measured: asked which files call
   * `generateDriftPlaylist`, the pack listed references to the file's *types* alongside the
   * function's calls, sorted them by path, and kept the first three — two type references
   * and one of the four calls the question was about.
   *
   * So: uses of a name the request asked about come first. Then each anchor in turn, one
   * call site at a time, so a file with many references cannot fill the list before every
   * anchor is represented. Within an anchor, callers the pack's neighbourhood already ranks
   * as relevant come first. The renderer groups by file for reading; this order is what
   * the budget sees.
   */
  public callSites(
    anchorFiles: string[],
    options: { named?: string[]; callerOrder?: string[]; protect?: string[]; limits?: BehaviorLimits } = {},
  ): { sites: CallSite[]; protectedCount: number } {
    const limits = options.limits ?? AGENT;
    const named = new Set(options.named ?? []);
    const protect = new Set(options.protect ?? []);
    const rank = new Map((options.callerOrder ?? []).map((p, i) => [p, i]));
    const rankOf = (from: string): number => rank.get(from) ?? Number.MAX_SAFE_INTEGER;

    const seen = new Map<string, CallSite>();
    const calls = new Set<CallSite>();
    const perAnchor: CallSite[][] = [];
    for (const file of anchorFiles.slice(0, limits.callSiteAnchors)) {
      const sites: CallSite[] = [];
      for (const ref of this.graph.referencesTo(file)) {
        if (!ref.to_file) continue;
        const key = `${ref.from_file}:${ref.line}:${ref.symbol_name}`;
        const known = seen.get(key);
        if (known) {
          // The index records a call and a plain identifier at the same spot; it is a call.
          if (ref.kind === 'call') calls.add(known);
          continue;
        }
        const site: CallSite = {
          from: ref.from_file,
          line: ref.line,
          symbol: ref.symbol_name,
          target: ref.to_file,
          provenance: ref.confidence === 'VERIFIED' ? 'VERIFIED' : 'UNKNOWN',
        };
        seen.set(key, site);
        if (ref.kind === 'call') calls.add(site);
        sites.push(site);
      }
      /*
        Calls before other references, then the neighbourhood's own ranking of callers.

        A call answers "who invokes this"; a type annotation in the same file does not. The
        engine dispatcher references each engine's track type eight lines above the line
        that calls the engine, and in file order the type came first — so the one call site
        per engine that survived the budget was the type, not the dispatch.
      */
      sites.sort((a, b) =>
        Number(!calls.has(a)) - Number(!calls.has(b))
        || rankOf(a.from) - rankOf(b.from) || a.from.localeCompare(b.from) || a.line - b.line);
      perAnchor.push(sites);
    }

    const out: CallSite[] = [];
    const taken = new Set<CallSite>();
    const take = (s: CallSite): boolean => {
      if (taken.has(s)) return false;
      taken.add(s);
      out.push(s);
      return true;
    };
    for (const sites of perAnchor) for (const s of sites) if (named.has(s.symbol)) take(s);

    /*
      What the budget may not remove: every use of a named symbol, and the first call site
      of each anchor the request named outright. Explicit anchors precede lexical ones in
      anchor order, so their first-round entries follow the named uses directly and the
      protected entries form a prefix of the list.
    */
    let protectedCount = out.length;
    const anchors = anchorFiles.slice(0, limits.callSiteAnchors);
    for (let round = 0; ; round++) {
      let more = false;
      perAnchor.forEach((sites, i) => {
        if (round >= sites.length) return;
        more = true;
        if (take(sites[round]!) && round === 0 && protect.has(anchors[i]!)) protectedCount++;
      });
      if (!more) break;
    }
    return { sites: out.slice(0, limits.callSites), protectedCount: Math.min(protectedCount, limits.callSites) };
  }

  private readLines(file: string): string[] | null {
    if (!this.repoRoot) return null;
    try {
      return fs.readFileSync(path.join(this.repoRoot, file), 'utf-8').split(/\r?\n/);
    } catch {
      // Deleted, unreadable, or outside the tree: no current behaviour to report, which
      // is a fact the pack states rather than a failure it hides.
      return null;
    }
  }

  /**
   * The declaration line, plus continuations while the signature is obviously unfinished.
   *
   * A multi-line parameter list is the common case in this codebase and a truncated one is
   * actively misleading — it can hide the very parameter the task is about.
   */
  private signatureAt(lines: string[], startLine: number): string | null {
    const first = lines[startLine - 1];
    if (first === undefined) return null;
    const parts = [first.trimEnd()];
    let open = balance(first);
    for (let i = startLine; i < lines.length && parts.length < MAX_SIGNATURE_LINES; i++) {
      const text = lines[i] ?? '';
      if (open <= 0 && /[{;=]\s*$/.test(parts[parts.length - 1] ?? '')) break;
      if (open <= 0) break;
      parts.push(text.trimEnd());
      open += balance(text);
    }
    const joined = parts.join('\n');
    return joined.trim().length ? joined : null;
  }
}

/** Net unclosed parentheses/brackets on a line, used to follow a wrapped signature. */
function balance(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[' || ch === '<') n++;
    else if (ch === ')' || ch === ']' || ch === '>') n--;
  }
  return n;
}
