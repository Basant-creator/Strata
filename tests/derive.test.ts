import { describe, it, expect } from 'vitest';
import { parseClaudeCodeTranscript } from '../src/derive/claude-code.js';
import { detectFindings, detectLineEndingInspection } from '../src/derive/signals.js';
import { deriveRecord } from '../src/derive/derive.js';
import { StrataRecordSchema } from '../src/schema/types.js';

/** Build an NDJSON transcript from envelope objects. */
function stream(...envelopes: unknown[]): string {
  return envelopes.map((e) => JSON.stringify(e)).join('\n');
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

const inspect = (raw: string) => detectLineEndingInspection(parseClaudeCodeTranscript(raw, 'r.jsonl'));

/** git's own warning, which is output the agent receives rather than a check it runs. */
const GIT_EOL_WARNING =
  "warning: in the working copy of 'backend/src/utils/driftAlgorithm.ts', LF will be replaced by CRLF the next time Git touches it";

describe('Claude Code transcript adapter', () => {
  it('normalises tool calls, results and the terminal envelope', () => {
    const raw = stream(
      { type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-opus-5' },
      toolUse('t1', 'Bash', { command: 'npm test' }),
      toolResult('t1', 'all good'),
      { type: 'result', subtype: 'success', num_turns: 4, duration_ms: 12000 },
    );

    const parsed = parseClaudeCodeTranscript(raw, 'run.jsonl');

    expect(parsed.adapter).toBe('claude-code');
    expect(parsed.session?.id).toBe('abc');
    expect(parsed.session?.agent).toBe('Claude Code');
    expect(parsed.outcome).toEqual({ status: 'success', numTurns: 4, durationSeconds: 12 });
    expect(parsed.events.map((e) => e.kind)).toEqual([
      'system',
      'tool_use',
      'tool_result',
      'result',
    ]);
  });

  it('skips malformed lines rather than deriving nothing from the rest', () => {
    const raw = [
      JSON.stringify(toolUse('t1', 'Bash', { command: 'ls' })),
      '{"type":"assistant","message":{"content"', // truncated capture
      JSON.stringify(toolResult('t1', 'ok')),
    ].join('\n');

    const parsed = parseClaudeCodeTranscript(raw, 'run.jsonl');
    expect(parsed.events).toHaveLength(2);
  });

  it('ignores thinking blocks, which are the agent narrating itself', () => {
    const raw = stream({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'I should probably mention the hang.' },
          { type: 'text', text: 'Done.' },
        ],
      },
    });

    const parsed = parseClaudeCodeTranscript(raw, 'run.jsonl');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.kind).toBe('assistant_text');
  });
});

describe('failure detectors', () => {
  it('detects a timeout even though the vendor does not flag it as an error', () => {
    // This is the case that made the module necessary: the tool result carries
    // is_error: false, because backgrounding a slow command is a successful
    // fallback. Nothing downstream of the error flag can see it.
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'cat > file.ts <<EOF' }),
      {
        type: 'tool_progress',
        parent_tool_use_id: 't1',
        elapsed_time_seconds: 300,
        heartbeat: true,
      },
      toolResult(
        't1',
        'Command did not complete within its 300s timeout and was moved to the background (ID: bg42).',
        false,
      ),
    );

    const findings = detectFindings(parseClaudeCodeTranscript(raw, 'run.jsonl'));
    const timeout = findings.find((f) => f.kind === 'timeout_backgrounded');

    expect(timeout).toBeDefined();
    expect(timeout?.severity).toBe('blocking');
    expect(timeout?.summary).toContain('300s');
    expect(timeout?.summary).toContain('at least 300s');
    expect(timeout?.detail).toContain('cat > file.ts');
  });

  it('attributes a killed background task back to the command that launched it', () => {
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'node slow.js' }),
      { type: 'system', subtype: 'task_started', task_id: 'bg42', tool_use_id: 't1', description: 'Exercise the options' },
      { type: 'system', subtype: 'task_updated', task_id: 'bg42', patch: { status: 'killed' } },
    );

    const findings = detectFindings(parseClaudeCodeTranscript(raw, 'run.jsonl'));
    const killed = findings.find((f) => f.kind === 'process_killed');

    expect(killed?.severity).toBe('blocking');
    expect(killed?.detail).toContain('Exercise the options');
    expect(killed?.detail).toContain('node slow.js');
  });

  it("detects a line-ending flip from git's warning and names the file", () => {
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'git diff' }),
      toolResult(
        't1',
        "warning: in the working copy of 'backend/src/utils/driftAlgorithm.ts', LF will be replaced by CRLF the next time Git touches it\n" +
          ' backend/src/utils/driftAlgorithm.ts | 39 ++++---\n',
      ),
    );

    const findings = detectFindings(parseClaudeCodeTranscript(raw, 'run.jsonl'));
    const eol = findings.find((f) => f.kind === 'line_ending_change');

    expect(eol?.files).toEqual(['backend/src/utils/driftAlgorithm.ts']);
    expect(eol?.summary).toContain('LF will be replaced by CRLF');
    // The detail must carry the check that works, and warn off the one that does
    // not: comparing against the git blob always agrees, because the blob is
    // stored normalised.
    expect(eol?.detail).toContain('siblings in the working tree');
    expect(eol?.detail).toContain('git blob');
  });

  it('separates a failing verification command from a failing tool call', () => {
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'npx tsc --noEmit' }),
      toolResult('t1', "src/a.ts(3,1): error TS2345: Argument of type 'x'.", false),
    );

    const findings = detectFindings(parseClaudeCodeTranscript(raw, 'run.jsonl'));
    expect(findings.map((f) => f.kind)).toContain('verification_failure');
    expect(findings.map((f) => f.kind)).not.toContain('tool_error');
  });

  it('does not flag an edit plus one correction as churn', () => {
    const twice = stream(
      toolUse('t1', 'Edit', { file_path: 'a.ts' }),
      toolUse('t2', 'Edit', { file_path: 'a.ts' }),
    );
    const thrice = stream(
      toolUse('t1', 'Edit', { file_path: 'a.ts' }),
      toolUse('t2', 'Edit', { file_path: 'a.ts' }),
      toolUse('t3', 'Write', { file_path: 'a.ts' }),
    );

    expect(detectFindings(parseClaudeCodeTranscript(twice, 'r.jsonl'))).toHaveLength(0);
    expect(
      detectFindings(parseClaudeCodeTranscript(thrice, 'r.jsonl')).map((f) => f.kind),
    ).toEqual(['repeated_write']);
  });

  it('reports nothing on a clean session', () => {
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'npx tsc --noEmit' }),
      toolResult('t1', 'no errors'),
      { type: 'result', subtype: 'success', permission_denials: [] },
    );
    expect(detectFindings(parseClaudeCodeTranscript(raw, 'r.jsonl'))).toHaveLength(0);
  });
});

describe('line-ending inspection detector', () => {
  // The metric this screen turns on. Four of five archived runs flipped a file's
  // line endings; the one that caught it compared against sibling working-tree
  // files, and the two that missed it compared against the git blob — which is
  // stored normalised, so it always agrees. `reference` is what separates them.

  it('1. records a sibling comparison as sibling_file', () => {
    const raw = stream(
      toolUse('t1', 'Bash', {
        command: "for f in src/utils/*.ts; do printf '%-45s ' \"$f\"; grep -c $'\\r' \"$f\"; done",
        description: 'Survey working-tree line endings',
      }),
      toolResult('t1', 'src/utils/driftAlgorithm.ts 0\nsrc/utils/frameAlgorithm.ts 438\n'),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(true);
    expect(result.reference).toBe('sibling_file');
    expect(result.confidence).toBe('VERIFIED');
    expect(result.eventIndices).toContain(0);
    expect(result.evidence[0]?.basis).toBe('command');
  });

  it('2. records a comparison against the stored object as git_blob', () => {
    const raw = stream(
      toolUse('t1', 'Bash', {
        command: "git show HEAD:backend/src/utils/driftAlgorithm.ts | grep -c $'\\r'",
        description: 'Compare against the committed version',
      }),
      toolResult('t1', '0\n'),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(true);
    expect(result.reference).toBe('git_blob');
    expect(result.confidence).toBe('VERIFIED');
  });

  it('2b. also recognises git cat-file and git checkout-index as blob references', () => {
    for (const command of [
      "git cat-file -p HEAD:src/a.ts | grep -c $'\\r'",
      "git checkout-index --stdout -- src/a.ts | grep -c $'\\r'",
    ]) {
      const result = inspect(stream(toolUse('t1', 'Bash', { command }), toolResult('t1', '0')));
      expect(result.checked).toBe(true);
      expect(result.reference).toBe('git_blob');
    }
  });

  it('3. reports unknown when a check happened but named no reference', () => {
    const raw = stream(
      assistantText('That CRLF warning is worth a look before I go further.'),
      toolUse('t1', 'Bash', {
        command: "grep -c $'\\r' backend/src/utils/driftAlgorithm.ts",
        description: 'Count carriage returns',
      }),
      toolResult('t1', '0\n'),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(true);
    expect(result.reference).toBe('unknown');
    // The check itself is still directly evidenced; only the reference is open.
    expect(result.confidence).toBe('VERIFIED');
  });

  it('4. reports checked=false when the session never looked', () => {
    const raw = stream(
      toolUse('t1', 'Edit', { file_path: 'backend/src/utils/driftAlgorithm.ts' }),
      toolResult('t1', 'ok'),
      toolUse('t2', 'Bash', { command: 'npx tsc --noEmit', description: 'Typecheck' }),
      toolResult('t2', 'no errors'),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(false);
    expect(result.reference).toBe('unknown');
    // A negative cannot be verified from a transcript.
    expect(result.confidence).toBe('UNKNOWN');
    expect(result.evidence).toEqual([]);
  });

  it('5. does not count a plain git diff as an inspection', () => {
    const raw = stream(
      toolUse('t1', 'Bash', {
        command: 'git diff -- backend/src/utils/driftAlgorithm.ts',
        description: 'Review the diff',
      }),
      toolResult('t1', 'diff --git a/x b/x\n@@ -21,6 +21,34 @@\n+export interface DriftGateOptions {\n'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  it('6. does not count a line-ending change in the diff as an inspection', () => {
    // git's warning is output the agent *received*, not a check it *ran*. The run
    // that read straight past this warning must not score as having checked.
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'git diff --stat', description: 'Review the diff' }),
      toolResult('t1', `${GIT_EOL_WARNING}\n backend/src/utils/driftAlgorithm.ts | 39 +++---\n`),
    );

    const result = inspect(raw);
    expect(result.checked).toBe(false);

    // The change detector still fires on the same transcript. The two answer
    // different questions and must not be wired to each other.
    const kinds = detectFindings(parseClaudeCodeTranscript(raw, 'r.jsonl')).map((f) => f.kind);
    expect(kinds).toContain('line_ending_change');
    expect(kinds).not.toContain('line_ending_inspection');
  });

  it('does not count stripping carriage returns as checking for them', () => {
    // Taken from a real archived run: the perl script that applied its refactor
    // normalised the file with `s/\r//g` on the way through. That command is the
    // cause of a line-ending flip, not a check for one, and an earlier version of
    // this detector scored it as an inspection — crediting the run that broke the
    // file with having looked at it.
    const raw = stream(
      toolUse('t1', 'Bash', {
        command:
          "perl -e '\nsub slurp { local $/; open my $fh, \"<\", $_[0] or die $!; " +
          "my $c = <$fh>; close $fh; $c =~ s/\\r//g; return $c; }\n' -- src/a.ts",
        description: 'Apply refactor to driftAlgorithm.ts',
      }),
      toolResult('t1', 'ok'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  it('does not count other carriage-return conversions', () => {
    for (const command of [
      "tr -d '\\r' < src/a.ts > src/a.tmp",
      "sed -i 's/\\r//g' src/a.ts",
      "node -e \"fs.writeFileSync(p, s.replace(/\\r/g, ''))\"",
    ]) {
      expect(inspect(stream(toolUse('t1', 'Bash', { command }), toolResult('t1', 'ok'))).checked).toBe(
        false,
      );
    }
  });

  it('does not count an edit that merely names line endings as a check', () => {
    // From a real archived run: "Apply refactor preserving CRLF" describes an
    // edit made with line endings in mind, not an inspection of them.
    const raw = stream(
      toolUse('t1', 'Bash', {
        command: "node -e \"fs.writeFileSync(p, out, {encoding:'utf8'})\" # \\r\\n kept",
        description: 'Apply refactor preserving CRLF',
      }),
      toolResult('t1', 'ok'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  it('does not count a byte dump without a stated purpose or settling output', () => {
    // `od` and `file` establish line endings when someone is asking, and mean
    // nothing when someone is not.
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'head -c 64 src/a.ts | od -c', description: 'Peek at the header' }),
      toolResult('t1', '0000000   / * *  \n'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  it('does not count talking about CRLF after the fact', () => {
    const raw = stream(
      toolUse('t1', 'Edit', { file_path: 'a.ts' }),
      toolResult('t1', 'ok'),
      assistantText('The file is CRLF like its siblings, so line endings are fine.'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  it('counts output that settles the question, such as file(1)', () => {
    const raw = stream(
      toolUse('t1', 'Bash', { command: 'file src/utils/a.ts src/utils/b.ts' }),
      toolResult(
        't1',
        'src/utils/a.ts: JavaScript source, ASCII text\n' +
          'src/utils/b.ts: JavaScript source, ASCII text, with CRLF line terminators\n',
      ),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(true);
    expect(result.reference).toBe('sibling_file');
    expect(result.evidence.some((e) => e.basis === 'output')).toBe(true);
  });

  it('counts an ambiguous call when its stated purpose names line endings', () => {
    const raw = stream(
      assistantText('Let me check whether I flipped the working-tree line endings.'),
      toolUse('t1', 'Bash', { command: 'file src/utils/a.ts src/utils/b.ts' }),
      toolResult('t1', 'src/utils/a.ts: ASCII text\nsrc/utils/b.ts: ASCII text\n'),
    );

    const result = inspect(raw);

    expect(result.checked).toBe(true);
    expect(result.reference).toBe('sibling_file');
    // Rests on a stated purpose rather than on the command text itself.
    expect(result.confidence).toBe('INFERRED');
    expect(result.evidence.some((e) => e.basis === 'purpose')).toBe(true);
  });

  it('does not let a stated purpose promote an action that cannot read the file', () => {
    const raw = stream(
      assistantText('Let me check the line endings.'),
      toolUse('t1', 'Bash', { command: 'npm run build', description: 'Check the line endings' }),
      toolResult('t1', 'built'),
    );

    expect(inspect(raw).checked).toBe(false);
  });

  describe('when one call touches both references', () => {
    // Real sessions do this constantly: one command reads siblings and pipes
    // `git show` on the same line. The commands alone cannot settle which
    // reference the conclusion rested on, so the stated conclusion decides.
    const bothRefs = (conclusion: string) =>
      stream(
        toolUse('t1', 'Bash', {
          command:
            "for f in src/utils/*.ts; do grep -c $'\\r' \"$f\"; done; " +
            "git show HEAD:src/utils/driftAlgorithm.ts | grep -c $'\\r'",
          description: 'Check line endings',
        }),
        toolResult('t1', 'disk 0\nsibling 438\nblob 0\n'),
        assistantText(conclusion),
      );

    it('takes git_blob when the conclusion rests on the committed file', () => {
      const result = inspect(bothRefs('Line endings unchanged (the committed file is LF too).'));
      expect(result.reference).toBe('git_blob');
      expect(result.confidence).toBe('INFERRED');
    });

    it('takes sibling_file when the conclusion rests on the siblings', () => {
      const result = inspect(
        bothRefs("My write stripped the file's CRLF endings (every sibling is CRLF)."),
      );
      expect(result.reference).toBe('sibling_file');
      expect(result.confidence).toBe('INFERRED');
    });

    it('takes the last attributing statement, which is the conclusion', () => {
      const raw = stream(
        toolUse('t1', 'Bash', {
          command:
            "for f in src/*.ts; do grep -c $'\\r' \"$f\"; done; git show HEAD:src/a.ts | grep -c $'\\r'",
        }),
        toolResult('t1', 'ok'),
        assistantText('Every sibling looks like CRLF, which would mean I flipped it.'),
        assistantText('On reflection the committed file is LF too, so line endings are untouched.'),
      );
      expect(inspect(raw).reference).toBe('git_blob');
    });

    it('stays unknown when no statement attributes the conclusion', () => {
      const result = inspect(bothRefs('The CRLF situation still needs a closer look.'));
      expect(result.reference).toBe('unknown');
    });
  });

  it('surfaces as a finding only when a check happened', () => {
    const checked = stream(
      toolUse('t1', 'Bash', { command: "for f in src/*.ts; do grep -c $'\\r' \"$f\"; done" }),
      toolResult('t1', 'ok'),
    );
    const notChecked = stream(
      toolUse('t1', 'Bash', { command: 'npx tsc --noEmit' }),
      toolResult('t1', 'no errors'),
    );

    const kinds = (raw: string) =>
      detectFindings(parseClaudeCodeTranscript(raw, 'r.jsonl')).map((f) => f.kind);

    expect(kinds(checked)).toContain('line_ending_inspection');
    expect(kinds(notChecked)).not.toContain('line_ending_inspection');
  });

  it('is reported on the derivation report for every session, checked or not', () => {
    const notChecked = deriveRecord(
      stream(toolUse('t1', 'Bash', { command: 'npx tsc --noEmit' }), toolResult('t1', 'ok')),
      'claude-code',
      'r.jsonl',
    );

    expect(notChecked.inspection).toEqual({
      checked: false,
      reference: 'unknown',
      confidence: 'UNKNOWN',
      evidence: [],
      eventIndices: [],
    });
  });
});

describe('record derivation', () => {
  const hangingRun = stream(
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5' },
    toolUse('t1', 'Edit', { file_path: 'src/gate.ts' }),
    toolResult('t1', 'ok'),
    toolUse('t2', 'Bash', { command: 'node probe.js' }),
    { type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 't2' },
    toolResult('t2', 'Command did not complete within its 300s timeout and was moved to the background (ID: bg1).'),
    { type: 'system', subtype: 'task_updated', task_id: 'bg1', patch: { status: 'killed' } },
    { type: 'result', subtype: 'success', num_turns: 9, duration_ms: 455000 },
  );

  it('downgrades a stream-reported success to partial when work was abandoned', () => {
    // The whole point. This session exits SUCCESS at the transport level; the
    // agent's own record for the real run of this shape reported no failures.
    const { record, findings } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl');

    expect(findings.filter((f) => f.severity === 'blocking')).toHaveLength(2);
    expect(record.result.status).toBe('partial');
    expect(record.result.summary).toContain('2 of them blocking');
    expect(record.attempts.every((a) => a.status === 'failed')).toBe(true);
  });

  it('marks the event VERIFIED and the reading of it INFERRED', () => {
    const { record } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl');

    expect(record.attempts.every((a) => a.confidence === 'INFERRED')).toBe(true);
    expect(record.evidence.every((e) => e.confidence === 'VERIFIED')).toBe(true);
    expect(record.evidence.some((e) => e.reference.startsWith('r3.jsonl#'))).toBe(true);
  });

  it('says UNKNOWN rather than inventing an intent when no prompt is available', () => {
    const { record } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl');

    expect(record.intentConfidence).toBe('UNKNOWN');
    expect(record.intent).toMatch(/^UNKNOWN:/);
  });

  it('takes the intent from a supplied prompt, skipping fenced code', () => {
    const { record } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl', {
      prompt:
        '# Task\n\n```ts\nconst LOWER = 104;\n```\n\nA reviewer flagged the three literals as unexplained magic numbers and asked for them to be made configurable.\n',
    });

    expect(record.intentConfidence).toBe('DECLARED');
    expect(record.intent).toContain('unexplained magic numbers');
    expect(record.intent).not.toContain('const LOWER');
  });

  it('names the finding in the title, not the derivation', () => {
    const { record } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl');
    expect(record.title).toContain('overran its timeout');
    expect(record.title).toContain('gate.ts');
  });

  it('collects changed files from edit tools and porcelain output, not from guesswork', () => {
    const raw = stream(
      toolUse('t1', 'Edit', { file_path: 'src/gate.ts' }),
      toolResult('t1', 'ok'),
      toolUse('t2', 'Bash', { command: 'git status --porcelain' }),
      toolResult('t2', ' M backend/src/utils/drift.ts\n?? .strata/\n'),
    );

    const { record } = deriveRecord(raw, 'claude-code', 'r.jsonl');
    const paths = record.files.map((f) => f.path);

    expect(paths).toContain('src/gate.ts');
    expect(paths).toContain('backend/src/utils/drift.ts');
    expect(paths.some((p) => p.includes('.strata'))).toBe(false);
  });

  it('produces a record that satisfies the Strata schema', () => {
    const { record } = deriveRecord(hangingRun, 'claude-code', 'r3.jsonl');
    const parsed = StrataRecordSchema.parse({
      ...record,
      id: 'REC-TEST',
      schemaVersion: '0.1.0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(parsed.id).toBe('REC-TEST');
  });

  it('rejects an unknown adapter instead of guessing a format', () => {
    expect(() => deriveRecord('{}', 'gemini', 'r.jsonl')).toThrow(/Unknown transcript adapter/);
  });
});
