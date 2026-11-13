/**
 * Applicability: how far a context pack can answer the request it was built for.
 *
 * Every other part of the pack reports what Strata found. This reports what that amounts
 * to, as one of four classes, so that nobody has to infer it from which sections happen to
 * be full. The sections alone cannot say it: a pack with every section populated can be
 * about a file the request only shared words with, and a pack with three UNKNOWN sections
 * can hold exactly the evidence the question needed.
 *
 *   SUPPORTED       the target was named; its current code and its history are VERIFIED
 *                   and settled; any record about it in the pack is current and not
 *                   contradicted by git.
 *   PARTIAL         the pack holds VERIFIED evidence about the target, and some of the
 *                   above is missing, unsettled, stale, unparsed or cut.
 *   LOW VALUE       little that is VERIFIED is about the target itself, or the target is a
 *                   guess its evidence does not firm up.
 *   NOT APPLICABLE  nothing was assembled: the target was not found, or nothing matched.
 *
 * How it is decided
 * -----------------
 * By rules checked in a fixed order, not by a score. A weighted sum lets strength in one
 * kind of evidence buy back an absence in another, and the absence is what the reader
 * needs to see. So each requirement is checked on its own, and a class below SUPPORTED
 * names every requirement it did not meet.
 *
 * Only VERIFIED evidence counts as support. A record is a claim; a derived attempt is
 * Strata's reading of a transcript. Both are listed with their labels, and neither can
 * lift a pack into SUPPORTED — and, being claims, neither is required for it: a target
 * with no record is reported as such (UNKNOWN why), not held down. What does hold a pack
 * down is a record about the target that is there and unreliable: written before later
 * changes to its files, cut by the budget, uncommitted, or contradicted by git.
 *
 * Every finding is a fact the pack or the store already holds, with its count or its id.
 * A low class says what was missing, stale, unsettled or cut. It never says why, because
 * nothing here knows.
 */

import type { ContextPack, Provenance } from './pack.js';
import { isRecordId } from '../code/graph.js';

export type ApplicabilityClass = 'SUPPORTED' | 'PARTIAL' | 'LOW VALUE' | 'NOT APPLICABLE';

export type ApplicabilityFacet =
  | 'target' | 'scope' | 'code' | 'relationships' | 'history' | 'memory'
  | 'provenance' | 'uncertainty' | 'budget';

/**
 * What a finding is.
 *
 * `basis` is VERIFIED evidence the class rests on. `claim` is DECLARED or INFERRED
 * material the pack carries: shown, never counted as verification. `limit` is something
 * missing, unsettled or weak. `omission` is evidence that exists and is not in this
 * pack — trimmed by the budget, left out by a cap, or named and not found.
 */
export type FindingEffect = 'basis' | 'claim' | 'limit' | 'omission';

export interface ApplicabilityFinding {
  facet: ApplicabilityFacet;
  effect: FindingEffect;
  /** The provenance of the evidence the finding is about. */
  label: Provenance;
  /** True for the findings that decided the class. */
  decisive: boolean;
  /** The finding in full, for a person. */
  text: string;
  /** The same finding in a few words, for the agent's block. */
  brief: string;
}

export interface Applicability {
  classification: ApplicabilityClass;
  /** The rule that decided the class, in words. */
  rule: string;
  /** Every finding, in facet order. */
  findings: ApplicabilityFinding[];
}

/**
 * What the engine knows that the pack does not carry.
 *
 * Gathered by the engine at build time and only read here, so the assessment stays a
 * function of its inputs: the same pack and the same facts give the same result.
 */
export interface ApplicabilityFacts {
  indexed: boolean;
  /** Commits Strata holds for the repository. Zero means no history was ever read. */
  repositoryCommits: number;
  /** Records the store holds, about anything. */
  storeRecords: number;
  /** Each resolved target file as the index holds it. */
  files: { path: string; language: string | null; declarations: number; exported: number }[];
  /** Named paths the index does not hold. */
  unresolved: { path: string; onDisk: boolean; indexable: boolean }[];
  /**
   * Paths the request names that are files in the working tree of a type the index does
   * not cover. The resolver does not treat these as claims about a file — their extension
   * is not one it knows — so it matches the request by its words instead.
   */
  unindexedPaths: string[];
  /** Named directories, and the files the resolver's ceiling left out of each. */
  directories: { directory: string; indexedFiles: number; leftOut: string[] }[];
  /** What the engine gathered before the budget trimmed anything. */
  found: {
    directCommits: string[];
    /** `commit path` for each change to a target file measured against HEAD. */
    targetDecisions: string[];
    codeFiles: string[];
  };
  /** Every commit in the index that changed a target file, before any cap. */
  directCommitsInIndex: number;
  /** Target files whose code a pack of this kind quotes, at most. */
  codeFileLimit: number;
  /** The records selected for the pack, nearest the target first. */
  records: {
    id: string;
    about: 'target' | 'connected' | 'wording';
    derived: boolean;
    /** False for a derived record whose session shows no commit. */
    committed: boolean;
    /** Commits that changed the record's target files after it was written, oldest first. */
    changedSince: string[];
    /** Commits the record names with files they did not change (see `contradictions.ts`). */
    contradicted?: { commit: string; files: string[] }[];
  }[];
}

/** The most characters the agent's block takes; findings beyond it are counted, not shown. */
export const APPLICABILITY_BLOCK_CHARS = 320;

// ------------------------------------------------------------------ assessment

class Findings {
  readonly all: ApplicabilityFinding[] = [];

  add(facet: ApplicabilityFacet, effect: FindingEffect, label: Provenance, text: string, brief: string): ApplicabilityFinding {
    const f: ApplicabilityFinding = { facet, effect, label, decisive: false, text, brief };
    this.all.push(f);
    return f;
  }
}

export function assessApplicability(pack: ContextPack, facts: ApplicabilityFacts): Applicability {
  const out = new Findings();
  const decide = (classification: ApplicabilityClass, rule: string, decisive: ApplicabilityFinding[]): Applicability => {
    for (const f of decisive) f.decisive = true;
    return { classification, rule, findings: out.all };
  };
  if (pack.targetNotFound) return notFound(pack, facts, out);

  /*
    A named file Strata cannot read, and a pack about other files.

    The request named a real file of a type the index does not cover, and with nothing
    else named the resolver fell back to the request's words: the pack is about whatever
    shared them. None of it is about the file that was named, so it does not apply, and
    its contents are not assessed as though they were.
  */
  const namedOutright = (pack.target.anchors ?? []).some((a) => a.kind !== 'lexical');
  if (facts.unindexedPaths.length && !namedOutright) {
    const decisive = facts.unindexedPaths.map((p) => out.add('target', 'limit', 'UNKNOWN',
      `${unresolvedText({ path: p, onDisk: true, indexable: false })}` +
      (pack.target.files.length ? '; the files in this view were matched by the request\'s other words, not by that name' : ''),
      `${p} not indexed (file type)`));
    return decide('NOT APPLICABLE',
      'the request names a file of a type Strata does not index, and nothing about that file was assembled',
      decisive);
  }

  // No target: nothing the request says names or matches a file. What the pack can
  // still hold is material that shares the request's words, and that is all it is.
  if (pack.target.resolution === 'none') {
    const none = out.add('target', 'limit', 'UNKNOWN', 'nothing in the request names or matches an indexed file', 'no target');
    const wording: ApplicabilityFinding[] = [];
    if (pack.historicalContext.length) {
      wording.push(out.add('history', 'limit', 'INFERRED',
        `${pack.historicalContext.length} commit(s) in this pack share words with the request; none is tied to code it names`,
        `${pack.historicalContext.length} commit(s) by wording only`));
    }
    if (facts.records.length) {
      wording.push(out.add('memory', 'limit', 'INFERRED',
        `${names(facts.records.map((r) => r.id), 4)}: matched by wording only, not shown to be about any code the request names`,
        `${facts.records.length} record(s) by wording only`));
    }
    return wording.length
      ? decide('LOW VALUE', 'nothing the request says names or matches a file; the pack holds only material that shares its words',
               [none, ...wording])
      : decide('NOT APPLICABLE', 'nothing in the repository matches the request, and no context was assembled', [none]);
  }

  const target = targetFindings(pack, out);
  const scope = scopeFindings(pack, facts, namedOutright, out);
  const code = codeFindings(pack, facts, out);
  relationshipFindings(pack, out);
  const history = historyFindings(pack, facts, out);
  const memory = memoryFindings(pack, facts, out);
  const provenance = provenanceFindings(pack, out);
  uncertaintyFindings(pack, out);
  const budget = budgetFindings(pack, out);

  // A target, and nothing VERIFIED about it: its existence is not context.
  const direct = code.quoted > 0 || history.shown > 0 || history.measured > 0 || pack.callSites.length > 0;
  if (!direct) {
    return decide('LOW VALUE',
      'nothing VERIFIED about the target itself is in this pack: no quoted code, no commit that changed it, no call site',
      [...(target.level === 'HIGH' ? [] : [target.finding]), ...code.gaps, ...history.gaps]);
  }

  /*
    A guess at the target.

    Its own evidence can make it a useful guess, never a supported one. What counts is
    VERIFIED evidence about the best match itself — its quoted code, a commit that changed
    it, a change to it measured against HEAD — and a record about it counts for nothing
    here, being a claim.
  */
  if (target.level === 'LOW') {
    const primary = pack.target.files[0] ?? '';
    const own = pack.currentBehavior.some((b) => b.file === primary)
      || pack.historicalContext.some((h) => h.relation === 'DIRECT_TARGET' && h.anchorFiles.includes(primary))
      || pack.historicalDecisions.some((d) => d.inTarget && d.path === primary);
    if (own) {
      return decide('PARTIAL',
        `the target was matched by wording, not named; the best match, ${primary}, has VERIFIED evidence of its own`,
        [target.finding]);
    }
    return decide('LOW VALUE',
      `the target was matched by wording only, and this pack holds nothing VERIFIED about the best match, ${primary}, itself`,
      [target.finding, ...code.gaps, ...history.gaps]);
  }

  // Everything SUPPORTED needs, each checked on its own.
  const unmet: ApplicabilityFinding[] = [];
  if (target.level !== 'HIGH') unmet.push(target.finding);
  unmet.push(...scope.findings);
  if (!code.covered) unmet.push(...code.gaps);
  if (!history.settled) unmet.push(...history.gaps, ...history.blockingOmissions);
  if (!memory.current) unmet.push(...memory.gaps);
  if (budget.exceeded) unmet.push(budget.exceeded);
  if (provenance && provenance.effect === 'limit') unmet.push(provenance);

  if (!unmet.length) {
    return decide('SUPPORTED',
      memory.present.length
        ? 'the target is named; its current code and settled history are VERIFIED, and the record about it is current'
        : 'the target is named; its current code and settled history are VERIFIED (no record is about it: why it is like this is UNKNOWN beyond commit messages)',
      [target.finding, ...code.bases, ...history.bases, ...memory.present]);
  }
  return decide('PARTIAL', `not SUPPORTED: ${unmet.map((f) => f.brief).join('; ')}`, unmet);
}

function notFound(pack: ContextPack, facts: ApplicabilityFacts, out: Findings): Applicability {
  const named = facts.unresolved.length
    ? facts.unresolved
    : (pack.target.unresolved ?? []).map((p) => ({ path: p, onDisk: false, indexable: true }));
  const decisive = named.map((u) => out.add('target', 'limit', 'UNKNOWN', unresolvedText(u), missingBrief(u.path)));
  for (const f of decisive) f.decisive = true;
  return {
    classification: 'NOT APPLICABLE',
    rule: named.some((u) => !isRecordId(u.path))
      ? 'the request names a path the code index does not hold, and no context was assembled'
      : 'the request names a record the store does not hold, and no context was assembled',
    findings: out.all,
  };
}

/** The short form of a missing name: a path is not in the index, a record id not in the store. */
function missingBrief(name: string): string {
  return isRecordId(name) ? `${name} not in the store` : `${name} not in the index`;
}

function unresolvedText(u: { path: string; onDisk: boolean; indexable: boolean }): string {
  if (isRecordId(u.path)) return `the store has no record ${u.path}`;
  if (u.onDisk && !u.indexable) {
    const ext = /\.[^./\\]+$/.exec(u.path)?.[0];
    return `${u.path} is in the working tree, but Strata does not index ${ext ? `${ext} files` : 'files without an extension'}: ` +
      'it parses TypeScript and JavaScript and registers data files by path, so no code, history or record was assembled for this file';
  }
  if (u.onDisk) return `${u.path} is in the working tree and not in the code index; \`strata index\` would add it`;
  return `${u.path} is not in the code index or the working tree`;
}

// ------------------------------------------------------------------ facets

type TargetLevel = 'HIGH' | 'MEDIUM' | 'LOW';

function targetFindings(pack: ContextPack, out: Findings): { level: TargetLevel; finding: ApplicabilityFinding } {
  const t = pack.target;
  const symbols = (t.anchors ?? []).filter((a) => a.kind === 'explicit_symbol').map((a) => `${a.matched} in ${a.file}`);
  const files = symbols.length ? names(symbols, 3) : names(t.files, 3);
  if (t.confidence.level === 'HIGH') {
    return { level: 'HIGH', finding: out.add('target', 'basis', 'VERIFIED',
      `the request names its target outright: ${files} (${t.confidence.reason}; confidence HIGH)`, 'named outright') };
  }
  if (t.confidence.level === 'MEDIUM') {
    return { level: 'MEDIUM', finding: out.add('target', 'limit', 'INFERRED',
      `the target, ${files}, was not named as a path or symbol: ${t.confidence.reason} (confidence MEDIUM)`,
      'resolved, not named (MEDIUM)') };
  }
  return { level: 'LOW', finding: out.add('target', 'limit', 'INFERRED',
    `the target was matched by wording only: ${t.confidence.reason} (confidence LOW); it resolved to ${files}`,
    'matched by wording (LOW)') };
}

function scopeFindings(
  pack: ContextPack, facts: ApplicabilityFacts, namedOutright: boolean, out: Findings,
): { findings: ApplicabilityFinding[] } {
  const findings: ApplicabilityFinding[] = [];
  for (const p of pack.target.unresolved ?? []) {
    const u = facts.unresolved.find((x) => x.path === p) ?? { path: p, onDisk: false, indexable: true };
    findings.push(out.add('scope', 'omission', 'UNKNOWN',
      `the request also names ${p}, which is not covered: ${unresolvedText(u)}`, missingBrief(p)));
  }
  // With nothing else named, an unindexed path decides the class instead; see above.
  for (const p of namedOutright ? facts.unindexedPaths : []) {
    findings.push(out.add('scope', 'omission', 'UNKNOWN',
      `the request also names ${p}, which is not covered: ${unresolvedText({ path: p, onDisk: true, indexable: false })}`,
      `${p} not indexed (file type)`));
  }
  for (const d of facts.directories) {
    if (!d.leftOut.length) continue;
    const covered = d.indexedFiles - d.leftOut.length;
    findings.push(out.add('scope', 'omission', 'VERIFIED',
      `${d.directory} holds ${d.indexedFiles} indexed files and this pack covers ${covered}; left out: ${names(d.leftOut, 6)}`,
      `covers ${covered} of ${d.indexedFiles} files in ${d.directory}`));
  }
  return { findings };
}

function codeFindings(pack: ContextPack, facts: ApplicabilityFacts, out: Findings): {
  quoted: number; covered: boolean; bases: ApplicabilityFinding[]; gaps: ApplicabilityFinding[];
} {
  const targets = pack.target.files;
  const quoted = pack.currentBehavior.filter((b) => targets.includes(b.file));
  const quotedFiles = new Set(quoted.map((b) => b.file));
  const bases: ApplicabilityFinding[] = [];
  const gaps: ApplicabilityFinding[] = [];

  if (!facts.indexed) {
    gaps.push(out.add('code', 'limit', 'UNKNOWN',
      'the code index is empty: current code, relationships and call sites are missing, not absent (run `strata index`)',
      'code index empty'));
  }
  if (quoted.length) {
    const declarations = quoted.reduce((n, b) => n + b.signatures.length + b.signaturesOmitted, 0);
    bases.push(out.add('code', 'basis', 'VERIFIED',
      `the current code of ${names(quoted.map((b) => b.file), 3)} is quoted from the working tree (${declarations} declaration(s))`,
      quoted.length === targets.length ? 'code quoted' : `code of ${quoted.length} of ${targets.length} target files quoted`));
  }
  // Why each unquoted target file is unquoted, one finding per reason.
  const why = { trimmed: [] as string[], data: [] as string[], empty: [] as string[], unexported: [] as string[], capped: [] as string[] };
  for (const file of targets) {
    if (quotedFiles.has(file)) continue;
    const info = facts.files.find((f) => f.path === file);
    if (facts.found.codeFiles.includes(file)) why.trimmed.push(file);
    else if (info?.language === 'data') why.data.push(file);
    else if (info && info.declarations === 0) why.empty.push(file);
    else if (info && info.exported === 0) why.unexported.push(file);
    else why.capped.push(file);
  }
  const one = (files: string[], single: string, many: string): string =>
    files.length === 1 ? single.replace('$', base(files[0]!)) : many.replace('$', String(files.length));
  if (why.trimmed.length) {
    gaps.push(out.add('code', 'omission', 'VERIFIED',
      `the current code of ${names(why.trimmed, 4)} was quoted and then trimmed to fit the budget`,
      one(why.trimmed, '$ code trimmed', 'code of $ target files trimmed')));
  }
  if (why.data.length) {
    gaps.push(out.add('code', 'limit', 'UNKNOWN',
      `${names(why.data, 4)}: data file(s), registered by path only; Strata extracts no declarations or relationships from them`,
      one(why.data, '$ not parsed (data file)', '$ data files not parsed')));
  }
  if (why.empty.length) {
    gaps.push(out.add('code', 'limit', 'UNKNOWN',
      `the parser took no declaration from ${names(why.empty, 4)}, so none of that code is quoted`,
      one(why.empty, 'no declarations in $', 'no declarations in $ target files')));
  }
  if (why.unexported.length) {
    gaps.push(out.add('code', 'limit', 'UNKNOWN',
      `${names(why.unexported, 4)}: declarations indexed, none exported; this pack quotes exported code only`,
      one(why.unexported, 'no exported code in $', 'no exported code in $ target files')));
  }
  if (why.capped.length) {
    gaps.push(out.add('code', 'omission', 'VERIFIED',
      `the current code of ${names(why.capped, 4)} is not quoted: this pack quotes the first ${facts.codeFileLimit} target file(s)`,
      one(why.capped, '$ code not quoted', 'code of $ target files not quoted')));
  }
  return { quoted: quoted.length, covered: quoted.length > 0 && !gaps.length, bases, gaps };
}

function relationshipFindings(pack: ContextPack, out: Findings): void {
  const targets = new Set(pack.target.files);
  const edges = pack.relationships.filter((r) => r.provenance === 'VERIFIED' && (targets.has(r.from) || targets.has(r.to)));
  const calls = pack.callSites.length;
  if (edges.length || calls) {
    out.add('relationships', 'basis', 'VERIFIED',
      `${edges.length} VERIFIED code relationship(s) and ${calls} call site(s) connect the target to other code`,
      `${edges.length} relationship(s), ${calls} call site(s)`);
  } else {
    out.add('relationships', 'limit', 'UNKNOWN',
      'no indexed relationship or call site connects the target to other code', 'no code relationships');
  }
}

function historyFindings(pack: ContextPack, facts: ApplicabilityFacts, out: Findings): {
  shown: number; measured: number; settled: boolean;
  bases: ApplicabilityFinding[]; gaps: ApplicabilityFinding[]; blockingOmissions: ApplicabilityFinding[];
} {
  const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
  const decisions = pack.historicalDecisions.filter((d) => d.inTarget);
  const settledOnes = decisions.filter((d) => d.status !== 'UNKNOWN');
  const open = decisions.filter((d) => d.status === 'UNKNOWN');
  const bases: ApplicabilityFinding[] = [];
  const gaps: ApplicabilityFinding[] = [];
  const blockingOmissions: ApplicabilityFinding[] = [];
  const result = (settled: boolean) => ({ shown: direct.length, measured: decisions.length, settled, bases, gaps, blockingOmissions });

  /*
    Two absences that read the same and are not.

    A repository whose history Strata never read says nothing about this code; a
    repository Strata has read, in which no commit touched it, says something definite.
    The first is UNKNOWN. The second is a VERIFIED absence within the history held.
  */
  if (facts.repositoryCommits === 0) {
    gaps.push(out.add('history', 'limit', 'UNKNOWN',
      'Strata holds no commits for this repository: the history of this code is UNKNOWN, not empty',
      'no repository history (UNKNOWN)'));
    return result(false);
  }
  if (!facts.found.directCommits.length) {
    const nearby = pack.historicalContext.length;
    gaps.push(out.add('history', 'limit', 'VERIFIED',
      `none of the ${facts.repositoryCommits} commits Strata holds changed the target` +
      (nearby ? `; the ${nearby} commit(s) in this pack touch connected files or share words only` : ''),
      'no commit changed it'));
    return result(false);
  }

  if (direct.length) {
    bases.push(out.add('history', 'basis', 'VERIFIED',
      `${direct.length} commit(s) that changed the target are in this pack: which commits and files is VERIFIED; their messages are DECLARED`,
      `${direct.length} target commit(s)`));
  }
  const trimmed = facts.found.directCommits.filter((c) => !direct.some((h) => h.shortHash === c));
  if (trimmed.length) {
    const f = out.add('history', 'omission', 'VERIFIED',
      `${trimmed.length} of the ${facts.found.directCommits.length} commit(s) that changed the target did not fit the budget: ${names(trimmed, 6)}`,
      `${trimmed.length} target commit(s) trimmed`);
    // A pack that still shows some of the target's commits has lost pointers; one that
    // shows none has lost its history.
    if (!direct.length) blockingOmissions.push(f);
  }
  const beyond = facts.directCommitsInIndex - facts.found.directCommits.length;
  if (beyond > 0) {
    out.add('history', 'omission', 'VERIFIED',
      `the index holds ${facts.directCommitsInIndex} commits that changed the target; this pack ranked ${facts.found.directCommits.length} of them in`,
      `${beyond} more target commit(s) ranked out`);
  }

  if (settledOnes.length) {
    const active = settledOnes.filter((d) => d.status === 'ACTIVE').length;
    const superseded = settledOnes.length - active;
    bases.push(out.add('history', 'basis', 'VERIFIED',
      `${settledOnes.length} change(s) to the target measured against HEAD: ${active} ACTIVE, ${superseded} SUPERSEDED`,
      `${settledOnes.length} of ${decisions.length} decision(s) settled`));
  }
  if (open.length) {
    gaps.push(out.add('history', 'limit', 'UNKNOWN',
      `${open.length} of the ${decisions.length} change(s) to the target shown are NOT ESTABLISHED: whether each still holds could not be determined`,
      `${open.length} of ${decisions.length} decision(s) NOT ESTABLISHED`));
  }
  const cutDecisions = facts.found.targetDecisions.length - decisions.length;
  if (cutDecisions > 0) {
    blockingOmissions.push(out.add('history', 'omission', 'VERIFIED',
      `${cutDecisions} measured change(s) to the target did not fit the budget`, `${cutDecisions} decision(s) trimmed`));
  }
  if (!decisions.length && cutDecisions <= 0) {
    gaps.push(out.add('history', 'limit', 'UNKNOWN',
      'no change to the target could be measured against HEAD', 'no decision measured'));
  }

  const settled = direct.length > 0 && settledOnes.length > 0 && settledOnes.length >= open.length && cutDecisions <= 0;
  return result(settled);
}

function memoryFindings(pack: ContextPack, facts: ApplicabilityFacts, out: Findings): {
  current: boolean; present: ApplicabilityFinding[]; gaps: ApplicabilityFinding[];
} {
  const omitted = new Set(pack.diagnostics.recordsOmitted);
  const target = facts.records.filter((r) => r.about === 'target');
  const present: ApplicabilityFinding[] = [];
  const gaps: ApplicabilityFinding[] = [];

  /*
    No record, and a record that is weak, are kept apart.

    "Nothing was ever written down here" and "something was written down and it may be out
    of date" call for different things from the reader, and a pack that says the same
    UNKNOWN for both hides the second.

    Only the second holds a pack below SUPPORTED. A record is a claim, and a claim cannot
    add support (see the header), so its absence cannot take support away either: the
    absence is reported, as UNKNOWN, and the class rests on the VERIFIED evidence. A record
    that *is* there and is out of date, cut, uncommitted or contradicted by git is a
    different matter: the pack carries a claim about the target the reader should not rely
    on, and that stays a gap.
  */
  if (facts.storeRecords === 0) {
    out.add('memory', 'limit', 'UNKNOWN',
      'the store holds no records at all: nothing about this repository has been written down, so why this code is like this is UNKNOWN beyond commit messages',
      'no records in the store (UNKNOWN)');
  } else if (!target.length) {
    out.add('memory', 'limit', 'UNKNOWN',
      `no record is about the target (the store holds ${facts.storeRecords}); why it is like this is UNKNOWN beyond commit messages`,
      'no record on it (UNKNOWN)');
  }

  for (const r of target) {
    // Before anything else about the record, and whether or not it fit: git shows that
    // part of what it says is false.
    if (r.contradicted?.length) {
      const c = r.contradicted[0]!;
      gaps.push(out.add('memory', 'limit', 'VERIFIED',
        `${r.id} is about the target and git contradicts it: it names ${c.commit} with ${c.files.join(', ')}, ` +
        `and ${c.commit} changed none of ${c.files.length > 1 ? 'them' : 'it'}` +
        (r.contradicted.length > 1 ? ` (${r.contradicted.length} such sentences)` : ''),
        `${r.id} contradicted by git (${c.commit})`));
    }
    if (omitted.has(r.id)) {
      gaps.push(out.add('memory', 'omission', 'DECLARED',
        `${r.id} is about the target and did not fit the budget: it exists and is not shown`, `${r.id} not shown (budget)`));
      continue;
    }
    const label: Provenance = r.derived ? 'INFERRED' : 'DECLARED';
    present.push(out.add('memory', 'claim', label, r.derived
      ? `${r.id} is about the target, derived from an agent session: its attempts are Strata's reading (INFERRED) and its statements are quotations (DECLARED)`
      : `${r.id} is about the target; what it says is a claim someone wrote down (DECLARED, unverified)`,
    `${r.id} on it (${label})`));
    if (r.changedSince.length) {
      gaps.push(out.add('memory', 'limit', 'DECLARED',
        `${r.id} was written before ${names(r.changedSince, 4)} changed its files; it may not describe the current code`,
        `${r.id} predates ${r.changedSince[0]}${r.changedSince.length > 1 ? ` (+${r.changedSince.length - 1})` : ''}`));
    }
    if (r.derived && !r.committed) {
      gaps.push(out.add('memory', 'limit', 'INFERRED',
        `${r.id} was derived from a session whose work shows no commit; what it describes may not be in the repository`,
        `${r.id} work not committed`));
    }
  }

  const connected = facts.records.filter((r) => r.about === 'connected' && !omitted.has(r.id)).map((r) => r.id);
  if (connected.length) {
    out.add('memory', 'claim', 'DECLARED',
      `${names(connected, 4)}: about code connected to the target, not the target itself (DECLARED)`,
      `${connected.length} record(s) on connected code`);
  }
  const wording = facts.records.filter((r) => r.about === 'wording' && !omitted.has(r.id)).map((r) => r.id);
  if (wording.length) {
    out.add('memory', 'limit', 'INFERRED',
      `${names(wording, 4)}: matched by wording only, not shown to be about this code`,
      `${wording.length} record(s) by wording only`);
  }
  const otherOmitted = facts.records.filter((r) => r.about !== 'target' && omitted.has(r.id)).map((r) => r.id);
  if (otherOmitted.length) {
    out.add('memory', 'omission', 'DECLARED',
      `records about other code did not fit the budget: ${names(otherOmitted, 4)}`,
      `${otherOmitted.length} other record(s) not shown`);
  }

  const elsewhere = facts.records.filter((r) => r.about !== 'target' && r.contradicted?.length);
  if (elsewhere.length) {
    out.add('memory', 'limit', 'VERIFIED',
      `git contradicts ${names(elsewhere.map((r) => `${r.id} (${r.contradicted![0]!.commit})`), 4)}, about code other than the target`,
      `${elsewhere.length} other record(s) contradicted by git`);
  }

  // No blocking problem with any record about the target, whether or not there is one.
  return { current: gaps.length === 0, present, gaps };
}

function provenanceFindings(pack: ContextPack, out: Findings): ApplicabilityFinding | undefined {
  const p = pack.provenanceSummary;
  const claims = p.DECLARED + p.INFERRED;
  const total = p.VERIFIED + claims;
  if (!total) return undefined;
  if (p.VERIFIED > claims) {
    return out.add('provenance', 'basis', 'VERIFIED',
      `${p.VERIFIED} of the pack's ${total} labelled statements are VERIFIED; its ${p.DECLARED} DECLARED and ${p.INFERRED} INFERRED ones are not counted as verification`,
      `${p.VERIFIED} VERIFIED vs ${claims} claims`);
  }
  return out.add('provenance', 'limit', p.DECLARED >= p.INFERRED ? 'DECLARED' : 'INFERRED',
    `only ${p.VERIFIED} of the pack's ${total} labelled statements are VERIFIED; the rest are claims (${p.DECLARED} DECLARED) or Strata's readings (${p.INFERRED} INFERRED)`,
    `mostly unverified (${p.VERIFIED} VERIFIED vs ${claims})`);
}

function uncertaintyFindings(pack: ContextPack, out: Findings): void {
  if (!pack.uncertainty.length) return;
  out.add('uncertainty', 'limit', 'UNKNOWN',
    `the pack records ${pack.uncertainty.length} thing(s) it could not establish (see UNCERTAINTY)`,
    `${pack.uncertainty.length} UNKNOWN item(s)`);
}

function budgetFindings(pack: ContextPack, out: Findings): { exceeded?: ApplicabilityFinding } {
  const d = pack.diagnostics;
  let exceeded: ApplicabilityFinding | undefined;
  if (d.budgetExceeded) {
    exceeded = out.add('budget', 'limit', 'VERIFIED',
      `the budget of ${d.maxTokens} tokens could not be met: this is the smallest pack Strata builds for this target`,
      'budget not met');
  }
  if (d.truncated) {
    const steps = d.sectionsTruncated;
    out.add('budget', 'omission', 'VERIFIED',
      `trimmed to fit ${d.maxTokens} tokens in ${steps.length} step(s): ${names(steps, 5)}` +
      (d.recordsOmitted.length ? `; records not shown: ${d.recordsOmitted.join(', ')}` : ''),
      `trimmed to fit ${d.maxTokens} tokens`);
  }
  return exceeded ? { exceeded } : {};
}

// ------------------------------------------------------------------ the agent's block

/*
  The block an agent reads first, and what it costs.

  It sits outside the token budget. Inside it, every character would come out of the
  evidence the budget protects, and on a tight pack that is a commit or a record: the one
  thing an explanation of the pack is worth less than. Outside it, the pack an agent
  receives is the pack it received before, with this block added and nothing else changed.

  So it is bounded instead. The class, whether the budget trimmed the pack, and the rule's
  first reason always show; the rest follow in priority order — what decided the class,
  then what was left out, then what the pack verifies, then the claims, then the rest —
  until *maxChars*, and whatever does not fit is counted rather than dropped silently.
*/
export function renderApplicabilityBlock(a: Applicability, maxChars = APPLICABILITY_BLOCK_CHARS): string[] {
  const decisive = a.findings.filter((f) => f.decisive);
  // On the heading, so that however little room the block has, a trimmed pack says so.
  const trimmed = a.findings.find((f) => f.facet === 'budget' && f.effect === 'omission');
  // A pack that does not apply is only its reason: whatever else it holds is about other
  // code, and listing it would read as though it were about this.
  const rest = a.classification === 'NOT APPLICABLE' ? []
    : a.findings.filter((f) => !f.decisive && f !== trimmed && f.facet !== 'uncertainty');
  const groups: { label: string; items: string[] }[] = [
    // For PARTIAL the reasons are what SUPPORTED needed and did not get.
    { label: a.classification === 'PARTIAL' ? 'gaps' : 'why', items: decisive.map((f) => f.brief) },
    { label: 'omitted', items: rest.filter((f) => f.effect === 'omission').map((f) => f.brief) },
    { label: 'verified', items: rest.filter((f) => f.effect === 'basis').map((f) => f.brief) },
    { label: 'claims', items: rest.filter((f) => f.effect === 'claim').map((f) => f.brief) },
    { label: 'also', items: rest.filter((f) => f.effect === 'limit').map((f) => f.brief) },
  ];

  const lines = [`## APPLICABILITY: ${a.classification}${trimmed && a.classification !== 'NOT APPLICABLE' ? ` · ${trimmed.brief}` : ''}`];
  let used = lines[0]!.length;
  let dropped = 0;
  const reserve = '\n- +99 more'.length;
  for (const [i, g] of groups.entries()) {
    let line = `- ${g.label}: `;
    let taken = 0;
    for (const item of g.items) {
      const piece = (taken ? '; ' : '') + item;
      if (used + 1 + line.length + piece.length <= maxChars - reserve) {
        line += piece;
        taken++;
      } else if (i === 0 && taken === 0) {
        // The first reason is shown whatever the room: a class without its reason is the
        // unexplained verdict this block exists to replace.
        const room = Math.max(12, maxChars - reserve - used - 1 - line.length);
        line += item.length > room ? `${item.slice(0, room - 1)}…` : item;
        taken++;
      } else {
        dropped++;
      }
    }
    if (taken) {
      lines.push(line);
      used += 1 + line.length;
    }
  }
  if (dropped) lines.push(`- +${dropped} more`);
  return lines;
}

// ------------------------------------------------------------------ helpers

function names(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

function base(file: string): string {
  return file.split('/').pop() ?? file;
}
