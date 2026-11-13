/**
 * The human views of a context pack: `strata explain` and `strata history`.
 *
 * Same pack, same engine, same provenance as the one an agent receives — built with
 * `detail: 'human'` so nothing about the target is capped — rendered for a developer
 * asking "why is this code like this?". There is no second history system here: every
 * line below is either a field of the pack, quoted with the label the pack gave it, or a
 * statement that something is UNKNOWN.
 *
 * Three rules shape the text, and each came from a measured failure of an earlier reader:
 *
 *  - Nothing is paraphrased into a reason. A commit message is the author's description
 *    (DECLARED); a record is a claim (DECLARED, quoted); a status is a measurement
 *    against HEAD (VERIFIED). None of them is restated as "because".
 *  - Order is not cause. The timeline says which commit came first — git knows that —
 *    and says outright that it does not claim one step led to the next.
 *  - Absence is stated. A section with nothing in it says UNKNOWN and why, because "no
 *    record of this" and "this did not happen" are different facts.
 */
import {
  ContextPack, HistoricalDecision, MemoryRecord, Provenance, Statement,
  unsettledDecision,
} from './pack.js';
import { FindingEffect } from './applicability.js';

export type HumanView = 'explain' | 'history';

const RULE = '─'.repeat(72);

const LABELS =
  'Labels   VERIFIED read from git or the working tree · DECLARED someone said so, not checked · ' +
  'INFERRED Strata\'s reading of the evidence · UNKNOWN not established';
const STATUSES =
  'Status   ACTIVE the change is still in the code at HEAD · SUPERSEDED a later commit replaced it · ' +
  'UNKNOWN partly rewritten, so whether it still holds is not established';
const CLASSES =
  'Classes  SUPPORTED named target, VERIFIED code and settled history, no unreliable record · PARTIAL VERIFIED ' +
  'evidence with some of that missing, unsettled, stale or cut · LOW VALUE little VERIFIED about the target · ' +
  'NOT APPLICABLE nothing assembled · decided by fixed rules, not a score';

/** Changed lines quoted per commit in the timeline before the rest are counted. */
const TIMELINE_LINES = 8;
/** Lines of a recovered deleted file shown before the rest are counted. */
const DELETED_LINES = 12;
/** Call sites listed per view before the rest are counted. */
const CALL_SITES = 12;

export function renderHuman(pack: ContextPack, view: HumanView): string {
  const out: string[] = [];
  header(out, pack, view);
  applicability(out, pack);
  if (pack.targetNotFound) {
    out.push('');
    out.push(`Nothing in this repository matches "${pack.target.query}".`);
    for (const u of pack.target.unresolved ?? []) out.push(`  not found: ${u}`);
    out.push('Strata answers only about code it can find; it does not guess a substitute.');
    return out.join('\n') + '\n';
  }

  const focus = focusSymbol(pack);
  if (view === 'explain') summary(out, pack, focus);
  current(out, pack, focus, view);
  if (view === 'history') timeline(out, pack);
  decisions(out, pack, focus);
  memory(out, pack);
  attempts(out, pack);
  constraints(out, pack);
  consequences(out, pack);
  deletedEvidence(out, pack);
  evidence(out, pack);
  provenance(out, pack);
  uncertainty(out, pack, focus, view);
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ header

function header(out: string[], pack: ContextPack, view: HumanView): void {
  const t = pack.target;
  out.push(`STRATA ${view.toUpperCase()} — ${t.query}`);
  out.push(RULE);
  const focus = focusSymbol(pack);
  if (focus) {
    out.push(`Target   ${focus.name} (${focus.kind}) in ${focus.file}:${focus.line}`);
  } else if (t.files.length === 1) {
    out.push(`Target   ${t.files[0]}`);
  } else if (t.files.length) {
    out.push(`Target   ${t.files.length} files: ${t.files.join(', ')}`);
  }
  out.push(`Resolved ${t.type} · ${t.resolution.replace(/_/g, ' ')} · confidence ${t.confidence.level} — ${t.confidence.reason}`);
  for (const d of t.directories ?? []) {
    if (!d.leftOut.length) continue;
    out.push(`         ${d.directory} holds ${d.indexedFiles} indexed files; this view covers ${d.indexedFiles - d.leftOut.length}.`);
    out.push(`         Left out: ${d.leftOut.join(', ')} — name one to see it.`);
  }
  if (t.confidence.level === 'LOW' || t.confidence.level === 'MEDIUM') {
    out.push('         This target was matched from the words of the request, not named outright.');
    out.push('         Check that the files above are the code you meant before relying on what follows.');
  }
  out.push(LABELS);
  out.push(STATUSES);
}

// ------------------------------------------------------------------ applicability

/**
 * How far this view can answer the request, first, so the rest is read knowing it.
 *
 * The same assessment the agent's pack carries, over the pack this view was built from,
 * with every finding in full. Each finding keeps the label of the evidence it is about,
 * and the ones that decided the class say so.
 */
function applicability(out: string[], pack: ContextPack): void {
  const a = pack.applicability;
  if (!a) return;
  section(out, 'APPLICABILITY — how far this view can answer the request');
  out.push(`${a.classification} — ${a.rule}`);
  const groups: [string, FindingEffect][] = [
    ['Verified — in this view', 'basis'],
    ['Claims — carried, not counted as verification', 'claim'],
    ['Falls short', 'limit'],
    ['Not in this view — exists, and is not shown', 'omission'],
  ];
  for (const [title, effect] of groups) {
    const items = a.findings.filter((f) => f.effect === effect);
    if (!items.length) continue;
    out.push(`  ${title}:`);
    for (const f of items) out.push(`    - ${f.text}  [${f.label}${f.decisive ? ' · decides the class' : ''}]`);
  }
  out.push(CLASSES);
}

// ------------------------------------------------------------------ explain summary

/**
 * The short answer, assembled only from what the sections below establish.
 *
 * Each line names its label. "Stated reasons" are the record's words and the authors'
 * commit messages, never Strata's; where neither exists the line says UNKNOWN.
 */
function summary(out: string[], pack: ContextPack, focus: FocusSymbol | undefined): void {
  section(out, 'WHY THIS CODE IS LIKE THIS — the short answer, from the sections below');
  const inTarget = pack.historicalDecisions.filter((d) => d.inTarget);

  const lines = pack.currentBehavior.reduce((n, b) => n + b.totalLines, 0);
  const exports = pack.currentBehavior.reduce((n, b) => n + b.signatures.filter((s) => s.exported !== false).length, 0);
  const locals = pack.currentBehavior.reduce((n, b) => n + b.signatures.filter((s) => s.exported === false).length, 0);
  const callers = new Set(pack.callSites.filter((c) => !focus || c.symbol === focus.name).map((c) => c.from));
  if (focus) {
    const uses = pack.callSites.filter((c) => c.symbol === focus.name).length;
    item(out, 'Now', `${focus.name} is defined at ${focus.file}:${focus.line}; used ${uses} time(s) from ${callers.size} file(s)`, 'VERIFIED');
  } else if (pack.currentBehavior.length) {
    item(out, 'Now', `${lines} line(s); ${exports} export(s), ${locals} module-level declaration(s); used from ${callers.size} file(s)`, 'VERIFIED');
  } else {
    item(out, 'Now', 'the current contents could not be read from the working tree', 'UNKNOWN');
  }

  const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
  if (direct.length) {
    const dates = direct.map((h) => h.authoredAt).sort((a, b) => a - b);
    item(out, 'History', `${direct.length} commit(s) changed it, ${day(dates[0]!)} to ${day(dates[dates.length - 1]!)}`, 'VERIFIED');
  } else {
    item(out, 'History', 'no commit that changed this code is in the history Strata holds', 'UNKNOWN');
  }

  for (const d of inTarget.filter((x) => x.status === 'ACTIVE')) {
    item(out, 'Still holds', `${d.commit} "${d.commitSubject}" — the code it added is at HEAD`, 'ACTIVE · VERIFIED');
  }
  for (const d of inTarget.filter((x) => x.status === 'SUPERSEDED')) {
    const by = d.supersededBy ? ` by ${d.supersededBy.shortHash}` : '';
    item(out, 'Replaced', `${d.commit} "${d.commitSubject}" — superseded${by}`, 'SUPERSEDED · VERIFIED');
  }
  const open = inTarget.filter((x) => x.status === 'UNKNOWN');
  if (open.length) {
    item(out, 'Not settled', `${open.map((d) => d.commit).join(', ')} — partly rewritten; whether each still holds is not established`, 'UNKNOWN');
  }

  const own = (pack.memory ?? []).filter((m) => m.about === 'target');
  if (own.length) {
    for (const m of own) {
      if (isDerived(m)) {
        // A derived record's title is Strata's headline for the session, not a reason.
        if (m.intentConfidence !== 'UNKNOWN') {
          item(out, 'Stated why', `${m.id} (derived from a transcript): its intent is the task prompt, quoted`,
            'DECLARED — the requester\'s words, unverified');
        }
        item(out, m.intentConfidence !== 'UNKNOWN' ? '' : 'Stated why', m.reasons.length
          ? `${m.id} (derived from a transcript) quotes ${m.reasons.length} reason(s) stated during the work`
          : `${m.id} (derived from a transcript): no reason was stated during the work`,
        m.reasons.length ? 'DECLARED — quotations, unverified' : 'UNKNOWN');
      } else {
        item(out, 'Stated why', `${m.id} claims: "${m.title}"`, `${m.intentConfidence} — the record's words, unverified`);
      }
    }
  } else {
    item(out, 'Stated why', 'no Strata record is about this code; nobody wrote down why', 'UNKNOWN');
  }
  if (direct.length) {
    item(out, '', 'commit messages are the authors\' own descriptions of each change', 'DECLARED');
  }

  const unknown: string[] = [];
  if (!own.some((m) => m.constraints.length)) unknown.push('any constraint on this code');
  if (!own.some((m) => m.attempts.length)) unknown.push('what was tried before');
  if (!own.some((m) => m.consequences.length)) unknown.push('what it left behind');
  if (!own.length) unknown.push('why it changed, beyond the commit messages');
  if (unknown.length) item(out, 'Not recorded', unknown.join('; '), 'UNKNOWN');
}

// ------------------------------------------------------------------ current

function current(out: string[], pack: ContextPack, focus: FocusSymbol | undefined, view: HumanView): void {
  section(out, 'CURRENT — what the code does now (read from the working tree)');
  if (!pack.currentBehavior.length) {
    out.push('UNKNOWN — the current contents could not be read from the working tree.');
    return;
  }
  for (const b of pack.currentBehavior) {
    out.push(`${b.file} — ${b.totalLines} line(s)  [${b.provenance}]`);
    const dependencies = b.signatures.filter((s) => s.kind === 'dependency');
    const exported = b.signatures.filter((s) => s.exported !== false && s.kind !== 'dependency');
    const local = b.signatures.filter((s) => s.exported === false && s.kind !== 'dependency');
    if (dependencies.length) {
      out.push('  declared dependencies:');
      for (const s of dependencies) declaration(out, `${b.file}:${s.line}`, s.text);
    }
    if (exported.length) {
      out.push('  exports:');
      for (const s of exported) declaration(out, `${b.file}:${s.line}`, s.text);
    }
    // A module-level constant is often exactly what the question is about, so the
    // declarations other code cannot import are quoted too, and said to be local.
    if (local.length) {
      out.push('  module-level declarations (not exported):');
      for (const s of local) declaration(out, `${b.file}:${s.line}`, s.text);
    }
    if (b.signaturesOmitted) out.push(`    … ${b.signaturesOmitted} further declaration(s) not quoted`);
    if (!b.signatures.length) out.push('  no top-level declaration the index could quote.');
  }
  const sites = focus ? pack.callSites.filter((c) => c.symbol === focus.name) : pack.callSites;
  const limit = view === 'explain' ? CALL_SITES : Math.min(CALL_SITES, 6);
  if (sites.length) {
    out.push(`  used at${focus ? ` (${focus.name})` : ''}:  [VERIFIED]`);
    for (const c of sites.slice(0, limit)) out.push(`    ${c.from}:${c.line}  ${c.symbol}`);
    if (sites.length > limit) out.push(`    … ${sites.length - limit} further use(s)`);
  } else {
    out.push('  used at: nothing in the index calls or references it.');
  }
}

// ------------------------------------------------------------------ history timeline

function timeline(out: string[], pack: ContextPack): void {
  section(out, 'TIMELINE — every commit that changed this code, oldest first');
  out.push('The order is VERIFIED from git. That one change led to the next is not claimed:');
  out.push('commits that follow each other are not evidence that one caused the other.');
  const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET')
    .sort((a, b) => a.authoredAt - b.authoredAt);
  if (!direct.length) {
    out.push('');
    out.push('UNKNOWN — no commit that changed this code is in the history Strata holds.');
  }
  const decisionsBy = new Map<string, HistoricalDecision[]>();
  for (const d of pack.historicalDecisions.filter((x) => x.inTarget)) {
    decisionsBy.set(d.commit, [...(decisionsBy.get(d.commit) ?? []), d]);
  }
  for (const h of direct) {
    out.push('');
    out.push(`${day(h.authoredAt)}  ${h.shortHash}  ${h.authorName}`);
    out.push(`  message (DECLARED — the author's description): "${h.subject}"`);
    const targetFiles = new Set([...h.anchorFiles, ...pack.target.files]);
    const own = (h.changes ?? []).filter((c) => targetFiles.has(c.path));
    for (const c of own) {
      const verb = c.status === 'add' ? 'created' : c.status === 'delete' ? 'deleted'
        : c.status === 'rename' ? `renamed from ${c.previousPath}` : 'modified';
      out.push(`  ${verb} ${c.path}  [${c.provenance}]`);
      const changed = changedLines(c.hunks);
      for (const l of changed.lines.slice(0, TIMELINE_LINES)) out.push(`      ${l}`);
      // The reader states what it cut both inside the hunk text and as a count; they
      // describe the same lines, so the larger is taken rather than the sum.
      const cut = Math.max(changed.omitted, c.linesOmitted);
      const hidden = Math.max(0, changed.lines.length - TIMELINE_LINES);
      const parts = [
        hidden ? `${hidden} further changed line(s)` : '',
        cut ? `${cut} further diff line(s) not shown` : '',
        c.hunksOmitted ? `${c.hunksOmitted} further hunk(s)` : '',
      ].filter(Boolean);
      if (parts.length) out.push(`      … ${parts.join(', ')}`);
    }
    if (!own.length) {
      out.push(`  changed ${h.anchorFiles.join(', ') || pack.target.files.join(', ')}  [VERIFIED]`);
      out.push('      the diff for this commit was not read; what it changed is not shown here.');
    }
    for (const d of decisionsBy.get(h.shortHash) ?? []) {
      out.push(`  decision: ${statusText(d)} — see HISTORICAL DECISIONS`);
    }
    const cited = (pack.memory ?? []).filter((m) => m.commits.includes(h.shortHash)).map((m) => m.id);
    if (cited.length) out.push(`  cited by: ${cited.join(', ')} (DECLARED records — see DEVELOPMENT MEMORY)`);
    if (h.alsoChanged?.length) {
      out.push(`  also changed: ${h.alsoChanged.join(', ')}${h.alsoChangedOmitted ? ` (+${h.alsoChangedOmitted} more)` : ''}`);
    }
    for (const f of h.historicalFiles ?? []) {
      const state = f.status === 'deleted' ? 'deleted' : 'no longer at HEAD';
      out.push(`  recovered: ${f.path} (${state}; read from ${f.sourceCommit.slice(0, 7)}) — see DELETED EVIDENCE`);
    }
  }

  const nearby = pack.historicalContext.filter((h) => h.relation === 'DIRECTLY_RELATED')
    .sort((a, b) => a.authoredAt - b.authoredAt);
  if (nearby.length) {
    out.push('');
    out.push('Nearby — commits to files connected to this code, not to the code itself (messages DECLARED):');
    const connected = new Set(pack.codeNeighborhood.map((n) => n.path));
    for (const h of nearby) {
      const via = h.touchedFiles.filter((f) => connected.has(f));
      out.push(`  ${day(h.authoredAt)}  ${h.shortHash}  "${h.subject}"${via.length ? `  — touched ${via.join(', ')}` : ''}`);
    }
  }
  const dropped = pack.historicalContext.length - direct.length - nearby.length;
  if (dropped > 0) {
    out.push('');
    out.push(`Left out: ${dropped} commit(s) related only by wording or at two removes — not history of this code.`);
  }
}

// ------------------------------------------------------------------ decisions

function decisions(out: string[], pack: ContextPack, focus: FocusSymbol | undefined): void {
  section(out, 'HISTORICAL DECISIONS — changes to this code, and whether each still holds');
  let own = pack.historicalDecisions.filter((d) => d.inTarget);
  if (!own.length) {
    out.push('UNKNOWN — no change to this code could be measured against HEAD.');
  }
  // For a symbol, the changes whose quoted lines name it come first, each group in status
  // order; the rest changed the same file and are said to.
  if (focus) {
    const names = (d: HistoricalDecision): boolean => mentions(d, focus.name);
    own = [...sortByStatus(own.filter(names)), ...sortByStatus(own.filter((d) => !names(d)))];
  } else {
    own = sortByStatus(own);
  }
  for (const d of own) {
    out.push('');
    out.push(`[${statusText(d)}] ${d.commit} · ${day(d.authoredAt)} · ${d.path}`);
    if (focus && !mentions(d, focus.name)) {
      out.push(`  (changed ${d.path}; the quoted lines do not name ${focus.name})`);
    }
    out.push(`  message (DECLARED): "${d.commitSubject}"`);
    out.push(`  status (${d.statusProvenance}): ${d.statusReason}`);
    if (d.supersededBy) out.push(`  superseded by (VERIFIED): ${d.supersededBy.shortHash} "${d.supersededBy.subject}"`);
    if (d.historicalState.length) {
      out.push('  before — lines this commit removed (VERIFIED):');
      for (const l of d.historicalState) out.push(`    - ${l.trim()}`);
      if (d.historicalOmitted) out.push(`    … ${d.historicalOmitted} further removed line(s)`);
    }
    if (d.currentState.length) {
      const where = d.currentIsAtHead ? 'still present at HEAD' : 'no longer present at HEAD';
      out.push(`  after — lines this commit added, ${where} (VERIFIED):`);
      for (const l of d.currentState) out.push(`    + ${l.trim()}`);
      if (d.currentOmitted) out.push(`    … ${d.currentOmitted} further added line(s)`);
    }
    if (d.consequences.length) {
      out.push(`  later commits to this file (VERIFIED): ${d.consequences.map((c) => `${c.shortHash} "${c.subject}"`).join('; ')}`);
    } else {
      out.push('  later commits to this file: none (VERIFIED)');
    }
    for (const s of d.support) {
      out.push(`  supporting evidence — ${s.kind}: ${s.reference}  [${s.provenance}]`);
      if (s.quote) out.push(`    "${s.quote.trim()}"`);
    }
    for (const w of d.whyItMatters.filter(informative)) out.push(`  (${w.provenance}) ${w.statement}`);
    if (d.caution) out.push(`  caution (${d.caution.provenance}): ${d.caution.statement}`);
  }

  const elsewhere = pack.historicalDecisions.filter((d) => !d.inTarget);
  if (elsewhere.length) {
    out.push('');
    out.push('Same commits, other files — shown because a schema or config changed alongside this code:');
    for (const d of sortByStatus(elsewhere)) {
      out.push(`  [${statusText(d)}] ${d.commit} ${d.path} — "${d.commitSubject}"`);
    }
  }
}

// ------------------------------------------------------------------ development memory

function memory(out: string[], pack: ContextPack): void {
  section(out, 'DEVELOPMENT MEMORY — Strata records (claims someone wrote down)');
  const records = pack.memory ?? [];
  if (!records.length) {
    out.push('UNKNOWN — no Strata record is about this code or the code connected to it.');
    out.push('Everything above comes from git and the working tree alone.');
    return;
  }
  for (const m of records) {
    const derived = isDerived(m);
    out.push('');
    out.push(`${m.id} — "${m.title}"`);
    out.push(`  about: ${aboutText(m)}`);
    if (derived) {
      out.push(`  derived automatically from an agent session transcript that ran on ${day(m.recordedAt)} — nobody wrote this record;`);
      out.push('    each part is the transcript\'s own content (VERIFIED), Strata\'s reading of it (INFERRED), or somebody\'s words quoted (DECLARED).');
      out.push(`  record status ${m.status}${m.supersededBy ? ` · superseded by ${m.supersededBy}` : ''}`);
    } else {
      out.push(`  recorded by ${m.author} on ${day(m.recordedAt)} · record status ${m.status}${m.supersededBy ? ` · superseded by ${m.supersededBy}` : ''}`);
    }
    out.push(`  files: ${m.files.join(', ')}`);
    if (m.symbols.length) {
      out.push(`  symbols the record names: ${m.symbols.map((s) => `${s.name} (${s.indexed ? 'in the index now' : 'not in the index now'})`).join(', ')}`);
    }
    // Before the record's words, so they are never read without it. The record is quoted
    // unchanged below; what is VERIFIED here is what the commits changed.
    for (const c of m.contradictions ?? []) {
      out.push(`  CONTRADICTED by git (VERIFIED): the record names ${c.commit} with ${c.files.join(', ')}; ` +
        `${c.commit} changed none of ${c.files.length > 1 ? 'them' : 'it'} (it changed ${c.changed.join(', ') || 'no listed file'}).`);
      out.push(`    the sentence: "${c.sentence}"`);
    }
    out.push(`  intent — ${claimLabel(m.intentConfidence)}:`);
    out.push(`    "${m.intent}"`);
    if (m.reasons.length) {
      out.push('  stated reasons — DECLARED, each quoted as the speaker wrote it:');
      for (const r of m.reasons) {
        out.push(`    - "${r.statement}"`);
        out.push(`      (${r.statedBy ?? 'unattributed'}${whereStated(r.evidence)}` +
          `${r.precedesAttempt !== undefined ? `; stated immediately before attempt ${r.precedesAttempt}, which is an ordering, not a cause` : ''})`);
      }
    }
    if (m.commits.length) out.push(`  cites commits (they exist in git — VERIFIED; what the record says about them is not): ${m.commits.join(', ')}`);
    out.push(`  result (${derived ? 'INFERRED — read from the transcript' : 'DECLARED'}): ${m.result.status}${m.result.summary ? ` — "${m.result.summary}"` : ''}`);
    if (derived && m.evidence.length) {
      out.push('  derived from:');
      for (const e of m.evidence) {
        out.push(`    - [${e.type}] ${e.reference}${e.description ? ` — ${e.description}` : ''} (${e.confidence})`);
      }
    }
    // A record describes the code as it was when written. Which commits changed that code
    // afterwards is a date comparison git can answer; whether those changes contradict the
    // record is left to the reader, with the diffs above to check it against. (A sentence
    // naming a commit that never touched the file it names is settled by git outright, and
    // is reported at the top of the record.)
    const later = pack.historicalContext
      .filter((h) => h.relation === 'DIRECT_TARGET' && h.authoredAt > m.recordedAt
        && [...h.anchorFiles, ...h.touchedFiles].some((f) => m.files.includes(f)))
      .sort((a, b) => a.authoredAt - b.authoredAt);
    if (later.length) {
      out.push(`  changed since this record was written (VERIFIED): ${later.map((h) => `${h.shortHash} (${day(h.authoredAt)})`).join(', ')}`);
      out.push('    what the record says about the current code may be out of date; compare with HISTORICAL DECISIONS.');
    }
  }
}

// ------------------------------------------------------------------ attempts

function attempts(out: string[], pack: ContextPack): void {
  section(out, 'PREVIOUS ATTEMPTS — what was tried, in the order the record gives');
  const records = (pack.memory ?? []).filter((m) => m.attempts.length);
  if (!records.length) {
    out.push('UNKNOWN — no previous attempt is recorded. Nobody wrote one down, which is not evidence that none was made.');
  }
  for (const m of records) {
    out.push('');
    out.push(`${m.id} (${aboutText(m)}):`);
    m.attempts.forEach((a, i) => {
      out.push(`  ${i + 1}. ${a.status.toUpperCase()} — ${claimLabel(a.confidence)}:`);
      out.push(`       "${a.approach}"`);
      if (a.failureReason) out.push(`       what happened: "${a.failureReason}"`);
      if (a.replacedBy) out.push(`       replaced by: "${a.replacedBy}"`);
      if (a.evidence?.length) out.push(`       evidence: ${a.evidence.join('; ')}`);
    });
  }
  const replaced = pack.historicalDecisions.filter((d) => d.inTarget && d.status === 'SUPERSEDED');
  if (replaced.length) {
    out.push('');
    out.push('Code that git shows was replaced (VERIFIED — see HISTORICAL DECISIONS):');
    for (const d of replaced) {
      out.push(`  ${d.commit} "${d.commitSubject}" — superseded${d.supersededBy ? ` by ${d.supersededBy.shortHash}` : ''}`);
    }
  }
}

// ------------------------------------------------------------------ constraints / consequences

function constraints(out: string[], pack: ContextPack): void {
  section(out, 'CONSTRAINTS — conditions a change to this code must respect');
  const found = (pack.memory ?? []).flatMap((m) => m.constraints.map((c) => ({ m, c })));
  if (!found.length) {
    out.push('UNKNOWN — no constraint is recorded for this code.');
    out.push('Git cannot record a constraint and Strata does not infer one from code that has survived.');
    return;
  }
  for (const { m, c } of found) {
    out.push(`- [${c.status}] ${claimLabel(c.confidence)} (${m.id}, ${aboutText(m)}${statedWhere(c)}):`);
    out.push(`    "${c.statement}"`);
  }
}

function consequences(out: string[], pack: ContextPack): void {
  section(out, 'CONSEQUENCES — what earlier work left behind');
  const found = (pack.memory ?? []).flatMap((m) => m.consequences.map((c) => ({ m, c })));
  if (!found.length) {
    out.push('UNKNOWN — no consequence of earlier work here is recorded.');
  }
  for (const { m, c } of found) {
    out.push(`- ${claimLabel(c.confidence)} (${m.id}, ${aboutText(m)}${statedWhere(c)}):`);
    out.push(`    "${c.statement}"`);
  }
  out.push('');
  out.push('Which later commits touched this code after each change is VERIFIED and listed per decision above;');
  out.push('that a later commit was a consequence of an earlier one is not claimed.');
}

// ------------------------------------------------------------------ deleted evidence

function deletedEvidence(out: string[], pack: ContextPack): void {
  section(out, 'DELETED EVIDENCE — files that no longer exist, read back from git');
  const files: { path: string; status: string; source: string; lines: string[]; omitted: number; via: string }[] = [];
  for (const h of pack.historicalContext) {
    for (const f of h.historicalFiles ?? []) {
      files.push({ path: f.path, status: f.status, source: f.sourceCommit.slice(0, 7), lines: f.lines,
                   omitted: f.linesOmitted, via: `${h.shortHash} (message DECLARED: "${h.subject}")` });
    }
  }
  const deletions = pack.historicalContext.flatMap((h) =>
    (h.changes ?? []).filter((c) => c.status === 'delete').map((c) => ({ h, c })));
  const tests = pack.historicalDecisions.flatMap((d) =>
    d.support.filter((s) => s.kind === 'deleted test' || s.kind === 'deleted file').map((s) => ({ d, s })));

  if (!files.length && !deletions.length && !tests.length) {
    out.push('None — no deleted file bears on this code in the history Strata read.');
    return;
  }
  for (const f of files) {
    out.push(`- ${f.path} — ${f.status === 'deleted' ? 'deleted' : 'no longer at HEAD'}; content read from ${f.source}  [VERIFIED]`);
    out.push(`    travelled with ${f.via}`);
    for (const l of f.lines.slice(0, DELETED_LINES)) out.push(`    | ${l}`);
    const rest = Math.max(0, f.lines.length - DELETED_LINES) + f.omitted;
    if (rest) out.push(`    | … ${rest} further line(s)`);
  }
  for (const { h, c } of deletions) {
    out.push(`- ${c.path} — deleted in ${h.shortHash}  [VERIFIED] (message DECLARED: "${h.subject}")`);
  }
  for (const { d, s } of tests) {
    out.push(`- ${s.reference} — ${s.kind}, attached to the ${d.commit} change to ${d.path}  [${s.provenance}]`);
    if (s.quote) out.push(`    "${s.quote.trim()}"`);
  }
}

// ------------------------------------------------------------------ evidence / provenance / uncertainty

function evidence(out: string[], pack: ContextPack): void {
  section(out, 'EVIDENCE — what the sections above rest on');
  const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET')
    .sort((a, b) => a.authoredAt - b.authoredAt);
  if (direct.length) {
    out.push('Commits that changed this code (exist in git — VERIFIED; messages DECLARED):');
    for (const h of direct) out.push(`  ${h.hash}  ${day(h.authoredAt)}  "${h.subject}"`);
  }
  const files = [...new Set(pack.currentBehavior.map((b) => b.file))];
  if (files.length) out.push(`Working tree read (VERIFIED): ${files.join(', ')}`);
  const records = pack.memory ?? [];
  if (records.length) out.push(`Records (DECLARED): ${records.map((m) => m.id).join(', ')}`);
  if (!direct.length && !files.length && !records.length) out.push('UNKNOWN — nothing about this code was found.');
}

function provenance(out: string[], pack: ContextPack): void {
  section(out, 'PROVENANCE — how much of this is checked');
  const p = pack.provenanceSummary;
  out.push(`VERIFIED ${p.VERIFIED} · DECLARED ${p.DECLARED} · INFERRED ${p.INFERRED} · UNKNOWN ${p.UNKNOWN}  (statements in the underlying pack)`);
  out.push('VERIFIED lines are exact git or file content. DECLARED lines are someone\'s words, quoted and');
  out.push('not checked — including every commit message and every record. INFERRED lines are Strata\'s');
  out.push('reading of VERIFIED evidence and say so. Nothing DECLARED has been upgraded.');
}

function uncertainty(out: string[], pack: ContextPack, focus: FocusSymbol | undefined, view: HumanView): void {
  section(out, 'UNCERTAINTY — what Strata could not establish');
  const items: string[] = [];
  // An UNKNOWN decision above already says it is not established; say it once.
  const restated = new Set(pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN')
    .map((d) => unsettledDecision(d.commit, d.path)));
  for (const u of pack.uncertainty) if (!restated.has(u)) items.push(u);
  const open = pack.historicalDecisions.filter((d) => d.inTarget && d.status === 'UNKNOWN');
  if (open.length) {
    items.push(`whether the changes made by ${open.map((d) => d.commit).join(', ')} still hold: each was partly rewritten later.`);
  }
  for (const c of pack.changeChains) for (const g of c.gaps) items.push(g);
  if (!(pack.memory ?? []).some((m) => m.about === 'target')) {
    items.push('why this code changed: no record states it, and commit messages are only the authors\' descriptions.');
  }
  if (focus) {
    items.push(`history is kept per file: a change is tied to ${focus.name} only where its quoted lines name it; the rest changed the same file.`);
  }
  if (pack.target.confidence.level === 'LOW' || pack.target.confidence.level === 'MEDIUM') {
    items.push(`whether ${pack.target.files.join(', ')} is the code the request meant: it was matched by wording (${pack.target.confidence.level}).`);
  }
  for (const d of pack.target.directories ?? []) {
    if (d.leftOut.length) items.push(`anything about ${d.leftOut.join(', ')}: ${d.directory} holds more files than this view covers.`);
  }
  for (const m of pack.memory ?? []) {
    if (!isDerived(m) || !m.attempts.length) continue;
    if (!m.evidence.some((e) => e.type === 'git_commit')) {
      items.push(`whether the work recorded in ${m.id} reached the repository: its transcript shows no commit.`);
    }
    if (!m.reasons.length) items.push(`why the work in ${m.id} was done the way it was: nothing in its transcript states a reason.`);
  }
  if (view === 'explain') {
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET').length;
    const q = /\s/.test(pack.target.query) ? `"${pack.target.query}"` : pack.target.query;
    if (direct) items.push(`the commit-by-commit detail is not shown here — \`strata history ${q}\` lists all ${direct}.`);
  }
  if (!items.length) {
    out.push('Nothing beyond what is marked UNKNOWN above.');
    return;
  }
  for (const i of [...new Set(items)]) out.push(`- UNKNOWN — ${i}`);
}

// ------------------------------------------------------------------ helpers

interface FocusSymbol { name: string; kind: string; file: string; line: number }

/** The symbol the request named, when it named one. */
function focusSymbol(pack: ContextPack): FocusSymbol | undefined {
  const named = pack.target.anchors?.find((a) => a.kind === 'explicit_symbol');
  if (!named) return undefined;
  return pack.target.symbols.find((s) => s.name === named.matched && s.file === named.file)
    ?? pack.target.symbols.find((s) => s.name === named.matched);
}

function mentions(d: HistoricalDecision, name: string): boolean {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return [...d.historicalState, ...d.currentState].some((l) => re.test(l));
}

function statusText(d: HistoricalDecision): string {
  return d.status === 'UNKNOWN' ? 'UNKNOWN — NOT ESTABLISHED' : d.status;
}

function sortByStatus(ds: HistoricalDecision[]): HistoricalDecision[] {
  const rank = { ACTIVE: 0, SUPERSEDED: 1, UNKNOWN: 2 } as const;
  return [...ds].sort((a, b) => rank[a.status] - rank[b.status] || b.authoredAt - a.authoredAt);
}

/** A decision's note that adds something the lines around it do not already say. */
function informative(s: Statement): boolean {
  return !/, which this query resolved to\.$/.test(s.statement);
}

function aboutText(m: MemoryRecord): string {
  return m.about === 'target' ? 'about this code'
    : m.about === 'connected' ? `about connected code (${m.files.join(', ')})`
    : 'matched by wording only — not shown to be about this code';
}

function claimLabel(p: Provenance): string {
  return p === 'DECLARED' ? 'DECLARED, unverified claim' : p;
}

/** A record Strata derived from a transcript, rather than one somebody wrote. */
function isDerived(m: MemoryRecord): boolean {
  return m.authorType === 'system';
}

/** Where a statement was made, when the record says: " at transcript.jsonl#17". */
function whereStated(evidence: string[]): string {
  return evidence.length ? `, at ${evidence.join('; ')}` : '';
}

/** "; stated by the agent at t.jsonl#17" for a statement that carries its source. */
function statedWhere(s: { statedBy?: string; evidence?: string[] }): string {
  if (!s.statedBy && !s.evidence?.length) return '';
  return `; ${s.statedBy ? `stated by ${s.statedBy}` : 'recorded'}${whereStated(s.evidence ?? [])}`;
}

/** The changed lines of a diff, without context lines or hunk headers. */
function changedLines(hunks: string[]): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let omitted = 0;
  for (const h of hunks) {
    for (const l of h.split('\n')) {
      const more = /^… (\d+) more line\(s\) in this hunk$/.exec(l);
      if (more) { omitted += Number(more[1]); continue; }
      if (/^[+-]/.test(l) && l.slice(1).trim()) lines.push(`${l[0]} ${l.slice(1).trim()}`);
    }
  }
  return { lines, omitted };
}

/** A quoted declaration; a signature that wraps keeps its continuation lines under it. */
function declaration(out: string[], where: string, text: string): void {
  const [first, ...rest] = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  out.push(`    ${where}  ${first ?? ''}`);
  for (const l of rest) out.push(`    ${' '.repeat(where.length)}    ${l}`);
}

function section(out: string[], title: string): void {
  out.push('');
  out.push(title);
  out.push(RULE);
}

function item(out: string[], key: string, text: string, label: string): void {
  out.push(`${key.padEnd(13)}${text}  [${label}]`);
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
