import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import {
  buildPromptContext, budgetForInline, CONTEXT_HEADER, INLINE_CONTEXT_LIMIT, inlineAgentContext,
} from '../src/integrations/claude-hook.js';

/**
 * Task-start delivery: the context has to be in front of the agent before it explores,
 * without the agent having to know Strata exists.
 *
 * Measured before this existed: in three of six controlled tasks the agent never called
 * Strata at all, and where it did the first call came at turn 5, 7 or 10. The packs were
 * right; they arrived after the exploration they were meant to prevent.
 *
 * These tests hold the hook to two promises. It delivers the *same* pack the validated
 * engine renders — no second retrieval path — and it never gets in the way of a prompt.
 */

const repoDir = path.join(process.cwd(), '.test_repo_hook');
const bareDir = path.join(process.cwd(), '.test_repo_hook_bare');
const wrapperDir = path.join(process.cwd(), '.test_repo_hook_wrapper');
const logFile = path.join(process.cwd(), '.test_hook_delivery.log');

function initRepo(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src', 'gate'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/gate/policy.ts'),
    'export const gatePolicy = { open: false };\nexport function allow(): boolean { return gatePolicy.open; }\n',
    'utf-8');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.com');
  git('config', 'user.name', 'Gate');
  git('add', '-A');
  git('commit', '-q', '-m', 'close the gate by default');
}

/**
 * A repository where the words a prompt wrapper is made of are also names in the code:
 * a data layer called `repository.ts`, a quiz with `answerQuestion`, an editor with
 * `editFiles`. The question is about the gate policy, and nothing else.
 */
function initWrapperRepo(): string {
  initRepo(wrapperDir);
  const put = (p: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(wrapperDir, p)), { recursive: true });
    fs.writeFileSync(path.join(wrapperDir, p), text, 'utf-8');
  };
  put('src/quiz/questionBank.ts',
    'export function answerQuestion(q: string): string { return q; }\nexport const onlyAnswers = true;\n');
  put('src/editor/fileEditor.ts',
    'export function editFiles(paths: string[]): void { void paths; }\nexport function editOnly(): void {}\n');
  put('src/data/repository.ts', 'export class Repository { about(): string { return "repo"; } }\n');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: wrapperDir, encoding: 'utf-8' });
  const policyCommit = git('log', '--format=%h', '-1').trim().slice(0, 7);
  git('add', '-A');
  git('commit', '-q', '-m', 'add the quiz, the editor and the data layer');
  const service = new StrataService(wrapperDir);
  service.init();
  service.indexCode();
  service.recordChange({
    id: 'REC-GATE',
    title: 'Gate closed by default',
    intent: 'Opening by default let unauthenticated callers through.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/gate/policy.ts', changeType: 'modify' }],
    attempts: [{ approach: 'Open by default and deny per caller', status: 'failed',
                 failureReason: 'New callers were admitted before a rule existed.', confidence: 'DECLARED' }],
    result: { status: 'success' },
  });
  service.close();
  return policyCommit;
}
let policyCommit = '';

beforeAll(() => {
  initRepo(repoDir);
  policyCommit = initWrapperRepo();
  initRepo(bareDir); // a repository with no Strata store at all
  const service = new StrataService(repoDir);
  service.init();
  service.indexCode();
  service.recordChange({
    id: 'REC-GATE',
    title: 'Gate closed by default',
    intent: 'Opening by default let unauthenticated callers through.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/gate/policy.ts', changeType: 'modify' }],
    attempts: [{ approach: 'Open by default and deny per caller', status: 'failed',
                 failureReason: 'New callers were admitted before a rule existed.', confidence: 'DECLARED' }],
    constraints: [{ statement: 'x'.repeat(900), confidence: 'DECLARED', status: 'ACTIVE' }],
    result: { status: 'success' },
  });
  service.close();
  if (fs.existsSync(logFile)) fs.rmSync(logFile);
}, 60_000);

afterAll(() => {
  for (const d of [repoDir, bareDir, wrapperDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  if (fs.existsSync(logFile)) fs.rmSync(logFile);
});

const PROMPT = 'Why is the policy in src/gate/policy.ts closed by default?';
const context = (r: ReturnType<typeof buildPromptContext>): string =>
  r.output!.hookSpecificOutput.additionalContext;
/** The delivered text with the applicability block taken out: what the hook sent before it existed. */
const withoutApplicability = (text: string): string => {
  const start = text.indexOf('\n## APPLICABILITY: ') + 1;
  if (start === 0) return text;
  return text.slice(0, start) + text.slice(text.indexOf('\n\n', start) + 2);
};
/*
  The default delivery, built once and read by every test that asks for it.

  Each call runs a full pack build, most of it spent starting git processes, and six tests
  make the identical call. Without a delivery log the hook has no side effects and its
  answer for one prompt and one store is the same every time, so one answer serves them
  all. Calls with options, a log, or another prompt are still made in the test that needs
  them.
*/
let promptDelivery: ReturnType<typeof buildPromptContext> | undefined;
const delivered = (): ReturnType<typeof buildPromptContext> =>
  (promptDelivery ??= buildPromptContext({ prompt: PROMPT, cwd: repoDir }));

describe('what the hook delivers', () => {
  it('delivers a UserPromptSubmit response for a prompt that resolves', () => {
    const r = delivered();
    expect(r.decision).toBe('delivered');
    expect(r.output!.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(r.targets).toContain('src/gate/policy.ts');
  });

  it('delivers exactly the pack the validated engine renders — no second retrieval path', () => {
    const r = delivered();
    const service = new StrataService(repoDir);
    try {
      // Same engine, at the budget the hook derives from the inline limit, with the
      // applicability block the hook sizes to the room left.
      const pack = service.getContextPack(PROMPT, { maxTokens: budgetForInline(INLINE_CONTEXT_LIMIT) });
      expect(context(r)).toBe(`${CONTEXT_HEADER}\n\n${inlineAgentContext(service, pack, INLINE_CONTEXT_LIMIT)}`);
      // The block is the only addition: without it, the delivery is the rendered pack exactly.
      expect(withoutApplicability(context(r))).toBe(`${CONTEXT_HEADER}\n\n${service.renderContextPack(pack)}`);
    } finally {
      service.close();
    }
  });

  it('preserves provenance, recorded memory and the truncation marker', () => {
    const text = context(delivered());
    expect(text).toContain('## PROVENANCE');
    expect(text).toMatch(/\(DECLARED\) \[REC-GATE\]/);
    expect(text).toMatch(/Open by default and deny per caller/);
    // The 900-character constraint is cut, and says so.
    expect(text).toMatch(/TRUNCATED — original 900 chars/);
  });

  it('adds only a neutral header: no instruction to trust it or to skip exploring', () => {
    expect(CONTEXT_HEADER).not.toMatch(/\b(trust|rely|authoritative|do not (explore|search|verify)|no need to)\b/i);
    expect(CONTEXT_HEADER).toMatch(/provenance/i);
  });

  it('delivers a named-but-missing path, because that is worth knowing before looking', () => {
    const r = buildPromptContext({ prompt: 'fix the bug in src/gate/doesNotExist.ts', cwd: repoDir });
    expect(r.decision).toBe('delivered');
    expect(context(r)).toContain('TARGET_NOT_FOUND');
  });

  it('resolves the repository from a subdirectory', () => {
    const r = buildPromptContext({ prompt: PROMPT, cwd: path.join(repoDir, 'src', 'gate') });
    expect(r.decision).toBe('delivered');
  });
});

describe('delivery fits inline', () => {
  // Measured on Claude Code 2.1.x: 9,900 characters are injected whole, 10,100 are
  // written to a file behind a 2 KB preview. The first version of this hook sent a
  // 12,800-character pack and so was never delivered inline at all.

  it('sizes the default pack to fit inside the inline limit', () => {
    const r = delivered();
    expect(context(r).length).toBeLessThanOrEqual(INLINE_CONTEXT_LIMIT);
    expect(r.oversize).toBe(false);
    expect(r.deliveredChars).toBe(context(r).length);
  });

  it('keeps the provenance legend and recorded memory inside that limit', () => {
    const text = context(delivered());
    expect(text).toContain('## PROVENANCE');
    expect(text).toMatch(/Open by default and deny per caller/);
  });

  it('honours an explicit budget, and says when that overflows the inline limit', () => {
    const r = buildPromptContext({ prompt: PROMPT, cwd: repoDir }, { maxTokens: 9000, inlineLimit: 1500 });
    expect(r.decision).toBe('delivered');
    expect(r.oversize).toBe(true);
  });

  it('derives a smaller budget from a smaller limit', () => {
    expect(budgetForInline(6000)).toBeLessThan(budgetForInline(10_000));
    expect(budgetForInline(10_000) * 4).toBeLessThan(INLINE_CONTEXT_LIMIT);
  });
});

describe('the hook resolves the task, not the wrapper around it', () => {
  // Measured on three controlled tasks: "why. Answer only" resolved on "answer" and "only"
  // to an unrelated test file in all three, and the wrapper sentence's words were scored
  // against every file. Here the same words are names in the code, so the damage is visible.
  const TASK = 'Why is the gate policy closed by default?';
  const WRAPPED = `Answer the question below about this repository.\n\n${TASK}\n\nAnswer only; do not edit files.`;
  const DECOYS = ['src/data/repository.ts', 'src/quiz/questionBank.ts', 'src/editor/fileEditor.ts'];
  // The wrapped prompt's default delivery, shared the same way as the plain one.
  let wrappedDelivery: ReturnType<typeof buildPromptContext> | undefined;
  const deliveredWrapped = (): ReturnType<typeof buildPromptContext> =>
    (wrappedDelivery ??= buildPromptContext({ prompt: WRAPPED, cwd: wrapperDir }));

  it('given the whole prompt, the unchanged engine anchors on the wrapper — the defect being fixed', () => {
    const service = new StrataService(wrapperDir);
    try {
      const pack = service.getContextPack(WRAPPED, { maxTokens: budgetForInline(INLINE_CONTEXT_LIMIT) });
      // "repository" names a file, so the wrapper's first sentence becomes the primary target.
      expect(pack.target.files[0]).toBe('src/data/repository.ts');
      for (const d of DECOYS) expect(pack.target.files).toContain(d);
    } finally {
      service.close();
    }
  });

  it('the hook resolves only what the task names', () => {
    const r = deliveredWrapped();
    expect(r.decision).toBe('delivered');
    expect(r.targets).toEqual(['src/gate/policy.ts']);
    expect(r.query).toBe(TASK);
    expect(r.removed).toEqual(['Answer the question below about this repository.', 'Answer only', 'do not edit files.']);
  });

  it('the wrapper changes nothing in the pack: same engine, same pack as the task alone', () => {
    const r = deliveredWrapped();
    const service = new StrataService(wrapperDir);
    try {
      const pack = service.getContextPack(TASK, { maxTokens: budgetForInline(INLINE_CONTEXT_LIMIT) });
      expect(context(r)).toBe(`${CONTEXT_HEADER}\n\n${inlineAgentContext(service, pack, INLINE_CONTEXT_LIMIT)}`);
      expect(withoutApplicability(context(r))).toBe(`${CONTEXT_HEADER}\n\n${service.renderContextPack(pack)}`);
    } finally {
      service.close();
    }
  });

  // The contrast is two builds — the hook's, and the engine's on the whole prompt — so it
  // is two tests, one build each, with the same assertions as when it was one.
  const TIGHT_INLINE = 4000;

  it('wrapper noise no longer pushes history and memory out of a tight budget', () => {
    const r = buildPromptContext({ prompt: WRAPPED, cwd: wrapperDir }, { inlineLimit: TIGHT_INLINE });
    const text = context(r);
    expect(text).toContain(policyCommit);                        // the commit that closed the gate
    expect(text).toMatch(/\(DECLARED\) \[REC-GATE\]/);
    expect(text).toMatch(/Open by default and deny per caller/);  // the failed attempt
    expect(text).toContain('## PROVENANCE');
  });

  // This used to show the commit lost to the decoys. Since the best-ranked history is the
  // last thing shed among commits without a diff, it survives even the whole prompt; the
  // decoys still take the targets, which the test above pins.
  it('the whole prompt at that budget still keeps the best-ranked commit', () => {
    const service = new StrataService(wrapperDir);
    try {
      const full = service.renderContextPack(
        service.getContextPack(WRAPPED, { maxTokens: budgetForInline(TIGHT_INLINE) }));
      expect(full).toContain(policyCommit);
    } finally {
      service.close();
    }
  });

  it('a prompt without a wrapper reaches the engine exactly as typed', () => {
    const r = delivered();
    expect(r.query).toBe(PROMPT);
    expect(r.removed).toEqual([]);
  });

  it('logs what was removed and what the engine was asked', () => {
    const log = path.join(process.cwd(), '.test_hook_wrapper.log');
    try {
      buildPromptContext({ prompt: WRAPPED, cwd: wrapperDir, session_id: 'w1' }, { deliveryLog: log });
      const entry = JSON.parse(fs.readFileSync(log, 'utf-8').trim());
      expect(entry.query).toBe(TASK);
      expect(entry.removed).toContain('Answer only');
      expect(entry.targets).toEqual(['src/gate/policy.ts']);
    } finally {
      if (fs.existsSync(log)) fs.rmSync(log);
    }
  });
});

describe('the hook never gets in the way', () => {
  it('delivers nothing where there is no Strata store', () => {
    const r = buildPromptContext({ prompt: PROMPT, cwd: bareDir });
    expect(r.output).toBeNull();
    expect(r.decision).toBe('skipped-no-store');
  });

  it('delivers nothing when the prompt names no reliable target', () => {
    const r = buildPromptContext({ prompt: 'make this faster', cwd: repoDir });
    expect(r.output).toBeNull();
    expect(r.decision).toBe('skipped-no-target');
  });

  it('delivers nothing for an empty prompt', () => {
    expect(buildPromptContext({ prompt: '   ', cwd: repoDir }).output).toBeNull();
  });

  it('fails open when something goes wrong', () => {
    const r = buildPromptContext({ prompt: PROMPT, cwd: path.join(repoDir, 'no', 'such', 'dir') });
    expect(r.output).toBeNull();
  });
});

describe('instrumentation', () => {
  it('logs every decision when asked, with a timestamp', () => {
    buildPromptContext({ prompt: PROMPT, cwd: repoDir, session_id: 's1' }, { deliveryLog: logFile });
    buildPromptContext({ prompt: 'make this faster', cwd: repoDir, session_id: 's2' }, { deliveryLog: logFile });
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.decision)).toEqual(['delivered', 'skipped-no-target']);
    expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
    expect(lines[0].session).toBe('s1');
  });

  it('a log path that cannot be written does not stop delivery', () => {
    const r = buildPromptContext({ prompt: PROMPT, cwd: repoDir },
      { deliveryLog: path.join(repoDir, 'src/gate/policy.ts', 'cannot', 'be', 'here.log') });
    expect(r.decision).toBe('delivered');
  });
});
