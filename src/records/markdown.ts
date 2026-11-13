/**
 * A record as a Markdown file a person can read, review and edit.
 *
 * Why this exists
 * ---------------
 * Records were JSON: exact for the program and awkward for everyone else. Changing one
 * meant hand-editing JSON, and a record in a pull request was a wall of quoted keys. The
 * generated `docs/strata/DECISIONS.md` made records readable but not editable: it is
 * rewritten from the store, so a correction made there is lost.
 *
 * So each record is now `.strata/records/<id>.md`. The prose (what was decided, why, what
 * was tried, the rules, the consequences) is Markdown sections; the fields Strata computes
 * on (status, timestamps, author, result) are a flat `key: value` block at the top, and
 * each list item carries its own labels as `key: value` sub-bullets. The file is the
 * canonical copy, committed with the code; SQLite is rebuilt from it.
 *
 * What it guarantees
 * ------------------
 * - Exact round trip. Writing a record and reading it back gives the same record, field
 *   for field, for every shape the schema allows (multi-line text, text that looks like
 *   Markdown, backticks inside a path). Text is trimmed: that is the only normalisation.
 * - Strict reading. A file that does not follow the format is an error with a line
 *   number, never a silent skip: a hand edit that breaks a record must be seen.
 * - VERIFIED stays Strata's to give. The header lists a short fingerprint of
 *   every item Strata itself wrote as VERIFIED. On reading, a VERIFIED label without its
 *   fingerprint — typed by hand, or left on an item whose text was edited — is read as
 *   DECLARED and reported. This catches a mistaken label, not a forger: anyone can
 *   recompute a fingerprint, exactly as anyone could edit the JSON before.
 */

import * as crypto from 'node:crypto';
import {
  StrataRecord, StrataRecordSchema, ConfidenceLevel,
} from '../schema/types.js';

/** Raised for a record file that does not follow the format. */
export class RecordFormatError extends Error {
  constructor(public readonly file: string, public readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = 'RecordFormatError';
  }
}

export interface ParsedRecordFile {
  record: StrataRecord;
  /** Items whose VERIFIED label Strata did not write, now read as DECLARED. */
  downgraded: string[];
}

// ------------------------------------------------------------------ fingerprints

/** Keys sorted, undefined dropped: the same item always serialises the same way. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Every item in *record* that carries a confidence label, with what identifies it. */
function labelled(record: StrataRecord): { kind: string; label: ConfidenceLevel; body: unknown; describe: string; set: (c: ConfidenceLevel) => void }[] {
  const strip = <T extends { confidence: ConfidenceLevel }>(x: T): Omit<T, 'confidence'> => {
    const { confidence: _c, ...rest } = x;
    return rest;
  };
  const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
  return [
    { kind: 'intent', label: record.intentConfidence, body: record.intent, describe: 'the intent',
      set: (c: ConfidenceLevel) => { record.intentConfidence = c; } },
    ...record.evidence.map((e) => ({ kind: 'evidence', label: e.confidence, body: strip(e),
      describe: `evidence ${e.type} ${e.reference}`, set: (c: ConfidenceLevel) => { e.confidence = c; } })),
    ...record.attempts.map((a) => ({ kind: 'attempt', label: a.confidence, body: strip(a),
      describe: `attempt "${short(a.approach)}"`, set: (c: ConfidenceLevel) => { a.confidence = c; } })),
    ...record.constraints.map((x) => ({ kind: 'constraint', label: x.confidence, body: strip(x),
      describe: `rule "${short(x.statement)}"`, set: (c: ConfidenceLevel) => { x.confidence = c; } })),
    ...record.consequences.map((x) => ({ kind: 'consequence', label: x.confidence, body: strip(x),
      describe: `consequence "${short(x.statement)}"`, set: (c: ConfidenceLevel) => { x.confidence = c; } })),
    ...record.reasons.map((x) => ({ kind: 'reason', label: x.confidence, body: strip(x),
      describe: `reason "${short(x.statement)}"`, set: (c: ConfidenceLevel) => { x.confidence = c; } })),
  ];
}

function fingerprint(id: string, kind: string, body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify([id, kind, canonical(body)])).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ text escaping

/**
 * A line of text inside a section or a list item. A line that would read as structure
 * (a heading, a list item, an escape, or an empty line inside an item) gets a leading
 * backslash, which the reader removes. Markdown renders `\#` and `\-` as the character.
 */
function escapeLine(line: string, inItem: boolean): string {
  if (/^[#\\]/.test(line)) return `\\${line}`;
  if (inItem && (line === '' || /^- /.test(line))) return `\\${line}`;
  return line;
}
function unescapeLine(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line;
}

/** A code span around *text*, fenced so that backticks inside it cannot close it. */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ /.test(text) && / $/.test(text)) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
/** Read a code span at the start of *text*: its content and what follows it. */
function readCode(text: string): { value: string; rest: string } | null {
  const open = /^`+/.exec(text);
  if (!open) return null;
  const fence = open[0];
  const close = text.indexOf(fence, fence.length);
  // The closing fence must be exactly as long, not part of a longer run.
  let at = close;
  while (at !== -1 && (text[at + fence.length] === '`' || text[at - 1] === '`')) at = text.indexOf(fence, at + 1);
  if (at === -1) return null;
  let value = text.slice(fence.length, at);
  if (value.length >= 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim()) value = value.slice(1, -1);
  return { value, rest: text.slice(at + fence.length) };
}

// ------------------------------------------------------------------ writing

const FRONT_KEYS = [
  'id', 'schema', 'status', 'superseded-by', 'recorded', 'updated',
  'author', 'author-email', 'author-type', 'agent', 'agent-model', 'agent-provider', 'agent-tool',
  'intent-confidence', 'result', 'verified',
] as const;

function single(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
  return value.trim();
}

/** Lines of a list item: its text, then its labels as sub-bullets. */
function item(text: string, labels: [string, string | undefined][]): string[] {
  const [first = '', ...more] = text.trim().split('\n');
  const out = [`- ${escapeLine(first, false)}`];
  for (const line of more) out.push(`  ${escapeLine(line, true)}`);
  for (const [key, value] of labels) {
    if (value === undefined) continue;
    const [v1 = '', ...vMore] = value.trim().split('\n');
    out.push(v1 ? `  - ${key}: ${escapeLine(v1, false)}` : `  - ${key}:`);
    for (const line of vMore) out.push(`    ${escapeLine(line, true)}`);
  }
  return out;
}

function block(text: string): string[] {
  return text.trim().split('\n').map((l) => escapeLine(l, false));
}

/** The Markdown file for *record*. */
export function renderRecordMarkdown(input: StrataRecord): string {
  const record = StrataRecordSchema.parse(input);
  const verified = labelled(record).filter((x) => x.label === 'VERIFIED')
    .map((x) => fingerprint(record.id, x.kind, x.body));
  const front: Record<string, string | undefined> = {
    id: record.id,
    schema: record.schemaVersion,
    status: record.status,
    'superseded-by': record.supersededBy,
    recorded: new Date(record.createdAt).toISOString(),
    updated: new Date(record.updatedAt).toISOString(),
    author: record.author.name,
    'author-email': record.author.email,
    'author-type': record.author.type,
    agent: record.agent?.name,
    'agent-model': record.agent?.model,
    'agent-provider': record.agent?.provider,
    'agent-tool': record.agent?.tool,
    'intent-confidence': record.intentConfidence,
    result: record.result.status,
    verified: verified.length ? verified.join(', ') : undefined,
  };
  const out = ['---'];
  for (const key of FRONT_KEYS) {
    const value = front[key];
    if (value !== undefined) out.push(single(key, value) ? `${key}: ${single(key, value)}` : `${key}:`);
  }
  out.push('---', '', `# ${single('title', record.title)}`, '', '## Decided', '', ...block(record.intent));

  out.push('', '## Files', '');
  for (const f of record.files) {
    out.push(...item(`${code(f.path)} (${f.changeType})`, (f.symbols ?? []).map((s) => ['symbol', s])));
  }
  if (record.symbols.length) {
    out.push('', '## Symbols', '');
    for (const s of record.symbols) out.push(`- ${code(s)}`);
  }
  if (record.evidence.length) {
    out.push('', '## Evidence', '');
    for (const e of record.evidence) {
      out.push(...item(`${e.type} ${code(e.reference)}${e.description !== undefined ? ` — ${e.description}` : ''}`,
        [['confidence', e.confidence]]));
    }
  }
  if (record.reasons.length) {
    out.push('', '## Why', '');
    for (const r of record.reasons) {
      out.push(...item(r.statement, [
        ['confidence', r.confidence], ...r.evidence.map((x): [string, string] => ['evidence', x]),
        ['stated by', r.statedBy], ['precedes attempt', r.precedesAttempt?.toString()],
      ]));
    }
  }
  if (record.attempts.length) {
    out.push('', '## Tried', '');
    for (const a of record.attempts) {
      out.push(...item(a.approach, [
        ['status', a.status], ['confidence', a.confidence], ['failure reason', a.failureReason],
        ['replaced by', a.replacedBy], ['sequence', a.sequence?.toString()],
        ...a.evidence.map((x): [string, string] => ['evidence', x]),
      ]));
    }
  }
  if (record.constraints.length) {
    out.push('', '## Rules to keep', '');
    for (const c of record.constraints) {
      out.push(...item(c.statement, [
        ['status', c.status], ['confidence', c.confidence],
        ...c.evidence.map((x): [string, string] => ['evidence', x]), ['stated by', c.statedBy],
      ]));
    }
  }
  if (record.consequences.length) {
    out.push('', '## Consequences', '');
    for (const c of record.consequences) {
      out.push(...item(c.statement, [
        ['confidence', c.confidence], ...c.evidence.map((x): [string, string] => ['evidence', x]),
        ['stated by', c.statedBy],
      ]));
    }
  }
  if (record.result.summary !== undefined && record.result.summary.trim()) {
    out.push('', '## Result', '', ...block(record.result.summary));
  }
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------ reading

interface Item { line: number; text: string; labels: { key: string; value: string; line: number }[] }

const SECTIONS = ['Decided', 'Files', 'Symbols', 'Evidence', 'Why', 'Tried', 'Rules to keep', 'Consequences', 'Result'] as const;
type Section = typeof SECTIONS[number];
const LIST_SECTIONS = new Set<Section>(['Files', 'Symbols', 'Evidence', 'Why', 'Tried', 'Rules to keep', 'Consequences']);

/** Parse the Markdown record file *text*; *file* names it in errors. */
export function parseRecordMarkdown(text: string, file: string): ParsedRecordFile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A final newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const fail = (line: number, message: string): never => { throw new RecordFormatError(file, line, message); };

  // The header block.
  if (lines[0] !== '---') fail(1, 'a record file starts with a "---" line');
  const front = new Map<string, string>();
  let i = 1;
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([a-z-]+):(?: (.*))?$/.exec(lines[i]!);
    if (!m) fail(i + 1, `expected "key: value" in the header, found "${lines[i]}"`);
    const [, key, value] = m!;
    if (!(FRONT_KEYS as readonly string[]).includes(key!)) fail(i + 1, `unknown header key "${key}"`);
    if (front.has(key!)) fail(i + 1, `header key "${key}" appears twice`);
    front.set(key!, (value ?? '').trim());
  }
  if (i >= lines.length) fail(1, 'the header is not closed with a "---" line');
  i++;

  // The title, then the sections.
  let title: string | undefined;
  const sections = new Map<Section, { line: number; body: string[] }>();
  let current: { line: number; body: string[] } | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    if (h1) {
      if (title !== undefined) fail(i + 1, 'a record has one "# " title');
      title = h1[1]!.trim();
      current = undefined;
    } else if (h2) {
      const name = h2[1]!.trim() as Section;
      if (!SECTIONS.includes(name)) fail(i + 1, `unknown section "## ${h2[1]}"; sections are ${SECTIONS.join(', ')}`);
      if (sections.has(name)) fail(i + 1, `section "## ${name}" appears twice`);
      current = { line: i + 1, body: [] };
      sections.set(name, current);
    } else if (/^#/.test(line)) {
      fail(i + 1, `only "# title" and "## section" headings are allowed; write "\\${line}" for a literal line`);
    } else if (current) {
      current.body.push(line);
    } else if (line.trim()) {
      fail(i + 1, title === undefined ? 'expected the "# title" line' : 'text before the first "## " section');
    }
  }
  if (title === undefined) fail(i, 'the record has no "# title" line');

  const textOf = (name: Section): string | undefined => {
    const s = sections.get(name);
    if (!s) return undefined;
    return s.body.map(unescapeLine).join('\n').trim();
  };
  const itemsOf = (name: Section): Item[] => {
    const s = sections.get(name);
    if (!s) return [];
    const items: Item[] = [];
    let label: Item['labels'][number] | undefined;
    s.body.forEach((line, k) => {
      const n = s.line + 1 + k;
      if (line === '') { label = undefined; return; }
      const top = /^- (.*)$/.exec(line);
      const sub = /^ {2}- ([a-z][a-z ]*?):(?: (.*))?$/.exec(line);
      if (top) {
        items.push({ line: n, text: unescapeLine(top[1]!), labels: [] });
        label = undefined;
      } else if (sub) {
        const owner = items[items.length - 1];
        if (!owner) fail(n, 'a "  - key: value" label must follow a "- " item');
        label = { key: sub[1]!, value: unescapeLine(sub[2] ?? ''), line: n };
        owner!.labels.push(label);
      } else if (/^ {4}/.test(line) && label) {
        label.value += `\n${unescapeLine(line.slice(4))}`;
      } else if (/^ {2}/.test(line) && items.length && !label) {
        // The item's own text: everything after the two-space indent, its own indent kept.
        items[items.length - 1]!.text += `\n${unescapeLine(line.slice(2))}`;
      } else {
        fail(n, `in "## ${name}", expected "- item", "  - key: value" or an indented continuation, found "${line}"`);
      }
    });
    return items;
  };
  for (const name of LIST_SECTIONS) {
    const s = sections.get(name);
    if (s && s.body.some((l) => l.trim()) && !itemsOf(name).length) fail(s.line, `"## ${name}" holds a list`);
  }

  /** The labels of *it*, checked against the keys its section allows. */
  const labelsOf = (it: Item, section: Section, allowed: string[], repeated: string[] = []) => {
    const seen = new Map<string, string>();
    const many = new Map<string, string[]>();
    for (const l of it.labels) {
      if (!allowed.includes(l.key) && !repeated.includes(l.key)) {
        fail(l.line, `"${l.key}" is not a label in "## ${section}"; labels are ${[...allowed, ...repeated].join(', ')}`);
      }
      if (repeated.includes(l.key)) many.set(l.key, [...(many.get(l.key) ?? []), l.value.trim()]);
      else if (seen.has(l.key)) fail(l.line, `label "${l.key}" appears twice`);
      else seen.set(l.key, l.value.trim());
    }
    return { one: (k: string) => seen.get(k), many: (k: string) => many.get(k) ?? [] };
  };
  const int = (value: string | undefined, line: number): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) fail(line, `expected a whole number, found "${value}"`);
    return Number(value);
  };
  const time = (key: string): number => {
    const v = front.get(key);
    if (v === undefined) fail(1, `the header has no "${key}"`);
    const t = Date.parse(v!);
    if (Number.isNaN(t)) fail(1, `"${key}" is not a date: "${v}"`);
    return t;
  };

  const files = itemsOf('Files').map((it) => {
    const c = readCode(it.text);
    const m = c && /^ \(([a-z]+)\)$/.exec(c.rest);
    if (!c || !m) fail(it.line, 'a file is written "- `path` (change)"');
    const l = labelsOf(it, 'Files', [], ['symbol']);
    const symbols = l.many('symbol');
    return { path: c!.value, changeType: m![1], ...(symbols.length ? { symbols } : {}) };
  });
  const symbols = itemsOf('Symbols').map((it) => {
    const c = readCode(it.text);
    if (!c || c.rest.trim()) fail(it.line, 'a symbol is written "- `name`"');
    return c!.value;
  });
  const evidence = itemsOf('Evidence').map((it) => {
    const type = /^([a-z_]+) /.exec(it.text);
    const c = type && readCode(it.text.slice(type[0].length));
    const desc = c && /^(?: —(?: ([\s\S]*))?)?$/.exec(c.rest);
    if (!type || !c || !desc) fail(it.line, 'evidence is written "- type `reference` — description"');
    const l = labelsOf(it, 'Evidence', ['confidence']);
    return {
      type: type![1], reference: c!.value,
      ...(c!.rest ? { description: desc![1] ?? '' } : {}),
      ...(l.one('confidence') !== undefined ? { confidence: l.one('confidence') } : {}),
    };
  });
  const optional = (k: string, v: string | number | undefined) => (v !== undefined ? { [k]: v } : {});
  const reasons = itemsOf('Why').map((it) => {
    const l = labelsOf(it, 'Why', ['confidence', 'stated by', 'precedes attempt'], ['evidence']);
    return {
      statement: it.text.trim(), evidence: l.many('evidence'),
      ...optional('confidence', l.one('confidence')), ...optional('statedBy', l.one('stated by')),
      ...optional('precedesAttempt', int(l.one('precedes attempt'), it.line)),
    };
  });
  const attempts = itemsOf('Tried').map((it) => {
    const l = labelsOf(it, 'Tried', ['status', 'confidence', 'failure reason', 'replaced by', 'sequence'], ['evidence']);
    return {
      approach: it.text.trim(), status: l.one('status'), evidence: l.many('evidence'),
      ...optional('confidence', l.one('confidence')), ...optional('failureReason', l.one('failure reason')),
      ...optional('replacedBy', l.one('replaced by')), ...optional('sequence', int(l.one('sequence'), it.line)),
    };
  });
  const constraints = itemsOf('Rules to keep').map((it) => {
    const l = labelsOf(it, 'Rules to keep', ['status', 'confidence', 'stated by'], ['evidence']);
    return {
      statement: it.text.trim(), evidence: l.many('evidence'),
      ...optional('status', l.one('status')), ...optional('confidence', l.one('confidence')),
      ...optional('statedBy', l.one('stated by')),
    };
  });
  const consequences = itemsOf('Consequences').map((it) => {
    const l = labelsOf(it, 'Consequences', ['confidence', 'stated by'], ['evidence']);
    return {
      statement: it.text.trim(), evidence: l.many('evidence'),
      ...optional('confidence', l.one('confidence')), ...optional('statedBy', l.one('stated by')),
    };
  });

  const agent = front.get('agent');
  const summary = textOf('Result');
  const parsed = StrataRecordSchema.safeParse({
    id: front.get('id'),
    schemaVersion: front.get('schema'),
    title,
    intent: textOf('Decided'),
    intentConfidence: front.get('intent-confidence'),
    author: {
      name: front.get('author'),
      ...optional('email', front.get('author-email')), ...optional('type', front.get('author-type')),
    },
    ...(agent !== undefined ? {
      agent: {
        name: agent, ...optional('model', front.get('agent-model')),
        ...optional('provider', front.get('agent-provider')), ...optional('tool', front.get('agent-tool')),
      },
    } : {}),
    files, attempts, evidence, constraints, consequences, reasons, symbols,
    status: front.get('status'),
    ...optional('supersededBy', front.get('superseded-by')),
    result: { status: front.get('result'), ...(summary ? { summary } : {}) },
    createdAt: time('recorded'),
    updatedAt: time('updated'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    fail(1, `${issue.path.join('.') || 'record'}: ${issue.message}`);
  }
  const record = parsed.data!;

  // VERIFIED only where Strata wrote it.
  const signed = new Set((front.get('verified') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const downgraded: string[] = [];
  for (const x of labelled(record)) {
    if (x.label === 'VERIFIED' && !signed.has(fingerprint(record.id, x.kind, x.body))) {
      x.set('DECLARED');
      downgraded.push(x.describe);
    }
  }
  return { record, downgraded };
}
