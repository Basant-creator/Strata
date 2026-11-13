import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { capStatement } from '../src/context/pack.js';
import type { ContextPack } from '../src/context/pack.js';

/**
 * Recorded statements must never look complete when they are not.
 *
 * Found by real agent validation, not by these tests. A 961-character recorded
 * decision reached the pack cut to 400 characters with nothing marking the cut —
 * the line ended mid-word and ran straight into its evidence references. An agent
 * read the fragment as the whole record and confidently disputed a claim the
 * record made 150 characters past the cut.
 *
 * The bug was never invention. It was amputation presented as a whole limb.
 */

const repoDir = path.join(process.cwd(), '.test_repo_trunc');
let service: StrataService;

/** Long enough to exceed the statement caps, with a distinctive tail. */
const LONG_TAIL = 'THE-PART-THAT-GETS-CUT';
const long = (lead: string): string =>
  `${lead} ${'filler clause that pads the statement out. '.repeat(20)}${LONG_TAIL}`;

/*
  A statement that ends with a dated note saying it no longer holds. The sentence and note
  are REC-16's consequence as corrected on 2026-11-13 (342 characters): cut from the end, the
  pack kept the stale sentence whole and showed the note as "since 622cc5f, recorde".
*/
const NOTED_SENTENCE = 'A referential prompt with a content word that matches something (then update REC-13) still gets a ' +
  'LOW pack: records in .strata/ are not indexed, so the words reach frozen experiment copies instead.';
const NOTE = 'No longer holds (noted 2026-11-13): since 622cc5f, recorded in REC-17, a record named by its id ' +
  'resolves to its record file with HIGH confidence';
const NOTED_RULE = 'Text is removed only in whole pieces where every scored word is about the exchange; anything naming ' +
  'a path, backticked span or code-shaped identifier is kept, whatever words surround it in the prompt.';
const RULE_NOTE = 'Superseded (noted 2026-11-13): since bc77088, recorded in REC-14, a workflow step is also cut from ' +
  'the edge of a clause that asks something';

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/gate.ts'), 'export const gate = 1;\n', 'utf-8');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repoDir, encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.com');
  git('config', 'user.name', 'A');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed the gate');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();

  service.recordChange({
    id: 'REC-SHORT',
    title: 'Short memory',
    intent: 'A short recorded decision.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/gate.ts', changeType: 'modify' }],
    constraints: [{ statement: 'Keep the gate closed by default.', confidence: 'DECLARED', status: 'ACTIVE' }],
    consequences: [{ statement: 'Callers must opt in.', confidence: 'DECLARED', evidence: ['commit:abc1234'] }],
    result: { status: 'success' },
  });

  service.recordChange({
    id: 'REC-LONG',
    title: 'Long memory',
    intent: long('A recorded decision far longer than the statement cap.'),
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/gate.ts', changeType: 'modify' }],
    constraints: [{
      statement: long('A constraint far longer than the cap.'),
      confidence: 'DECLARED', evidence: ['commit:def5678'], status: 'ACTIVE',
    }],
    consequences: [{
      statement: long('A consequence far longer than the cap.'),
      confidence: 'DECLARED', evidence: ['commit:def5678'],
    }],
    result: { status: 'success' },
  });

  service.recordChange({
    id: 'REC-NOTED',
    title: 'A consequence that no longer holds',
    intent: 'A short recorded decision.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/gate.ts', changeType: 'modify' }],
    constraints: [{ statement: `${NOTED_RULE} ${RULE_NOTE}`, confidence: 'DECLARED', status: 'SUPERSEDED' }],
    consequences: [{ statement: `${NOTED_SENTENCE} ${NOTE}`, confidence: 'DECLARED' }],
    result: { status: 'success' },
  });
}, 60_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per budget, shared by every test that asks for it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel: test 8b built four packs inside one five-second test and
  took ~3.3 s under the suite. Most tests read the 9,000-token pack, packs are only read and
  rendered, and nothing here changes the store or the index after setup.
*/
const built = new Map<string, ContextPack>();
const pack = (opts = {}): ContextPack => {
  const key = JSON.stringify(opts);
  let p = built.get(key);
  if (!p) {
    p = service.getContextPack('src/gate.ts', opts);
    built.set(key, p);
  }
  return p;
};
const find = (list: { statement: string }[], id: string) =>
  list.find((s) => s.statement.includes(id));

// ------------------------------------------------------------- the helper

describe('capStatement', () => {
  it('leaves a statement that fits exactly as it was', () => {
    const out = capStatement('[REC-1] ', 'short body', 400);
    expect(out).toBe('[REC-1] short body');
    expect(out).not.toMatch(/TRUNCATED/);
  });

  it('marks a statement that does not fit, and states the original length', () => {
    const body = 'x'.repeat(961);
    const out = capStatement('[REC-1] ', body, 400);
    expect(out).toMatch(/TRUNCATED — original 961 chars/);
    expect(out.startsWith('[REC-1] ')).toBe(true);
  });

  it('counts the marker inside the limit, so signalling loss cannot grow the pack', () => {
    for (const size of [401, 961, 5000]) {
      const out = capStatement('[REC-1] ', 'x'.repeat(size), 400);
      expect(out.length, `body of ${size} exceeded the cap`).toBeLessThanOrEqual(400);
    }
  });

  it('still signals the loss when the limit cannot hold prefix and marker', () => {
    const out = capStatement('[REC-1] a very long prefix indeed — ', 'x'.repeat(500), 40);
    expect(out).toMatch(/TRUNCATED/);
  });
});

// ------------------------------------------------------- 1-4: rendered output

describe('short statements are rendered whole', () => {
  it('1. a short constraint carries no truncation marker', () => {
    const s = find(pack({ maxTokens: 9000 }).constraints, 'REC-SHORT')!;
    expect(s).toBeDefined();
    expect(s.statement).toContain('Keep the gate closed by default.');
    expect(s.statement).not.toMatch(/TRUNCATED/);
  });

  it('3. a short consequence carries no truncation marker', () => {
    const s = find(pack({ maxTokens: 9000 }).consequences, 'REC-SHORT')!;
    expect(s.statement).toContain('Callers must opt in.');
    expect(s.statement).not.toMatch(/TRUNCATED/);
  });
});

describe('long statements say that they were cut', () => {
  it('2. a long constraint is marked, and the lost tail is genuinely absent', () => {
    const s = find(pack({ maxTokens: 9000 }).constraints, 'REC-LONG')!;
    expect(s).toBeDefined();
    expect(s.statement).toMatch(/TRUNCATED — original \d+ chars/);
    // The marker is honest: the tail really is gone, so nothing is claiming to
    // show what it does not show.
    expect(s.statement).not.toContain(LONG_TAIL);
  });

  it('4. a long consequence is marked the same way', () => {
    const s = find(pack({ maxTokens: 9000 }).consequences, 'REC-LONG')!;
    expect(s.statement).toMatch(/TRUNCATED — original \d+ chars/);
    expect(s.statement).not.toContain(LONG_TAIL);
  });

  it('2b. a long recorded decision (record intent) is marked', () => {
    const s = find(pack({ maxTokens: 9000 }).decisionsAndConstraints, 'REC-LONG')!;
    expect(s.statement).toMatch(/TRUNCATED — original \d+ chars/);
  });
});

// ------------------------------------------------- 5-7: metadata survives

describe('truncation costs the text and nothing else', () => {
  it('5. DECLARED stays DECLARED', () => {
    const p = pack({ maxTokens: 9000 });
    for (const list of [p.constraints, p.consequences, p.decisionsAndConstraints]) {
      const s = find(list, 'REC-LONG');
      if (s) expect(s.provenance).toBe('DECLARED');
    }
  });

  it('6. evidence references survive', () => {
    const s = find(pack({ maxTokens: 9000 }).constraints, 'REC-LONG')!;
    expect(s.evidence.length).toBeGreaterThan(0);
    expect(s.evidence.join(',')).toContain('REC-LONG');
  });

  it('7. the record id survives, so the fragment stays attributable', () => {
    const s = find(pack({ maxTokens: 9000 }).constraints, 'REC-LONG')!;
    expect(s.statement.startsWith('[REC-LONG]')).toBe(true);
  });
});

// ------------------------------------------------------------- 8, 9: limits

describe('the marker holds up under pressure', () => {
  it('8. under a tight budget, a surviving fragment is still marked', () => {
    const tight = pack({ maxTokens: 900 });
    const survivors = [...tight.constraints, ...tight.consequences, ...tight.decisionsAndConstraints]
      .filter((s) => s.statement.includes('REC-LONG'));
    // Either the section was trimmed away — which the diagnostics report — or what
    // survived says it is incomplete. What must never happen is a bare fragment.
    for (const s of survivors) {
      if (!s.statement.includes(LONG_TAIL)) expect(s.statement).toMatch(/TRUNCATED/);
    }
    if (survivors.length === 0) {
      expect(tight.diagnostics.sectionsTruncated.length).toBeGreaterThan(0);
    }
  });

  // One test per budget, so each builds at most one pack; the assertions are the loop's.
  it.each([700, 1500, 3200, 9000])('8b. no rendered memory statement is ever a silent fragment (%i tokens)', (budget) => {
    const p = pack({ maxTokens: budget });
    for (const s of [...p.constraints, ...p.consequences, ...p.decisionsAndConstraints]) {
      if (!s.statement.includes('REC-LONG')) continue;
      const whole = s.statement.includes(LONG_TAIL);
      expect(whole || /TRUNCATED/.test(s.statement),
        `budget ${budget}: fragment presented as complete`).toBe(true);
    }
  });

  it('9. git-derived historical evidence is untouched by this', () => {
    const p = pack({ maxTokens: 9000 });
    const text = service.renderContextPack(p);
    // The quoted diff/behaviour material carries its own omission notices and must
    // not have acquired the statement marker.
    // Bounded to the section itself: slicing to the end of the document would
    // swallow the memory sections that follow it, which legitimately do carry the
    // marker.
    const from = text.indexOf('## HISTORICAL CONTEXT');
    const next = text.indexOf('\n## ', from + 1);
    const historySection = text.slice(from, next === -1 ? undefined : next);
    expect(historySection).not.toMatch(/TRUNCATED — original/);
    for (const b of p.currentBehavior) expect(b.provenance).toBe('VERIFIED');
  });
});

// ------------------------------------------- a dated note that it no longer holds

describe('a dated note that the statement no longer holds is not what gets cut', () => {
  const PREFIX = '[REC-16] src/code/graph.ts, src/records/service.ts — ';

  it('the sentence before the note gives way; the note stays whole, inside the limit', () => {
    const body = `${NOTED_SENTENCE} ${NOTE}`;
    expect(body.length).toBe(342);
    const out = capStatement(PREFIX, body, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith(`${PREFIX}A referential prompt`)).toBe(true);
    expect(out).toContain(` […] ${NOTE} [TRUNCATED — original 342 chars]`);
    // Nothing after the note was cut, so no ellipsis follows it.
    expect(out).not.toContain(`${NOTE} …`);
  });

  it('cut from the end, as before this fix, the note lost what replaced the claim', () => {
    const body = `${NOTED_SENTENCE} ${NOTE}`;
    const old = `${PREFIX}${body.slice(0, 300 - PREFIX.length - ' … [TRUNCATED — original 342 chars]'.length)}`;
    expect(old).toContain(NOTED_SENTENCE);
    expect(old).not.toContain('resolves to its record file');
  });

  it('a note too long to keep whole is cut from its end, after its label and the sentence opening', () => {
    const longNote = `${NOTE}; ${'and a further clause about what changed. '.repeat(12)}`;
    const out = capStatement(PREFIX, `${NOTED_SENTENCE} ${longNote}`, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain('A referential prompt');
    expect(out).toContain(' […] No longer holds (noted 2026-11-13): since 622cc5f');
    expect(out).toMatch(/ … \[TRUNCATED — original \d+ chars\]$/);
  });

  it('a limit too small for the opening and the note label falls back to a marked cut from the end', () => {
    const out = capStatement(PREFIX, `${NOTED_SENTENCE} ${NOTE}`, 150);
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out).toMatch(/ … \[TRUNCATED — original 342 chars\]$/);
  });

  it('a statement that fits, with or without a note, is unchanged', () => {
    expect(capStatement(PREFIX, `${NOTED_SENTENCE} ${NOTE}`, 600)).toBe(`${PREFIX}${NOTED_SENTENCE} ${NOTE}`);
    expect(capStatement('[REC-1] ', `Short. ${NOTE}`, 300)).toBe(`[REC-1] Short. ${NOTE}`);
  });

  it('a statement that is only a note, or has none, is cut from the end as before', () => {
    const only = capStatement('[REC-1] ', `${NOTE} ${'x'.repeat(400)}`, 200);
    expect(only).not.toContain(' […] ');
    const none = capStatement('[REC-1] ', 'x'.repeat(961), 400);
    expect(none).toBe(`[REC-1] ${'x'.repeat(400 - '[REC-1] '.length - ' … [TRUNCATED — original 961 chars]'.length)} … [TRUNCATED — original 961 chars]`);
  });

  it('in a pack, the consequence shows its whole note', () => {
    const p = pack({ maxTokens: 9000 });
    const s = find(p.consequences, 'REC-NOTED')!;
    expect(s).toBeDefined();
    expect(s.statement).toContain(NOTE);
    expect(s.statement).toContain(' […] ');
    expect(s.statement).toMatch(/\[TRUNCATED — original \d+ chars\]$/);
  });

  it('in a pack, a superseded rule shows its whole note beside its status', () => {
    const s = find(pack({ maxTokens: 9000 }).constraints, 'REC-NOTED')!;
    expect(s.statement.startsWith('[REC-NOTED] [SUPERSEDED]')).toBe(true);
    expect(s.statement).toContain(RULE_NOTE);
  });

  it('rendered, the note closes the quotation with no ellipsis, and the marker stays outside it', () => {
    const text = service.renderContextPack(pack({ maxTokens: 9000 }));
    expect(text).toContain(`${NOTE}" [TRUNCATED — original `);
    expect(text).not.toContain(`${NOTE} …"`);
    // A statement cut from the end keeps its ellipsis inside the quotation, as before.
    expect(text).toMatch(/filler clause[^"\n]* …" \[TRUNCATED — original \d+ chars\]/);
  });
});
