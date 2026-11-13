/**
 * Contradictions: where git itself disagrees with what a record says.
 *
 * A record is a claim, labelled DECLARED and shown as one. That label is honest about
 * where a statement came from, and says nothing about whether git agrees with it.
 * Labelled, never checked.
 *
 * What is checked, and only this
 * ------------------------------
 * The one kind of claim git can settle on its own: a sentence that credits a commit with a
 * change ("… was rewritten in 027f9b1", "b1613b6 added …") and names a file. If the store
 * holds that commit, knows which files it changed, and none of the files the sentence names
 * is among them, git contradicts the sentence. That is a VERIFIED fact about the commit, not
 * a judgement about the record. A sentence that only cites a commit beside a file ("stated
 * in fef3e2b and in the comment in X") makes no such claim and is not checked.
 *
 * Nothing else is inferred. A cited commit the store does not hold is UNKNOWN, not
 * contradicted (the commit cache is bounded); a commit with no recorded file list, such as
 * a merge, is not evidence against anything; a sentence that names a commit and no file
 * makes no claim about a file; a claim about what a change *did* to a file it really
 * touched ("stopped proxying in f9558c1") is not something a file list can refute, and is
 * left alone. The record itself is never edited: its text, its provenance and its history
 * are kept, and the contradiction is reported beside it.
 */

export interface CommitFacts {
  shortHash: string;
  changedFiles: string[];
}

/** One sentence of a record that git contradicts. */
export interface RecordContradiction {
  /** The commit as the store names it. */
  commit: string;
  /** The files the sentence names, as written in the sentence. */
  files: string[];
  /** The files that commit actually changed (VERIFIED), at most a few. */
  changed: string[];
  /** The sentence, quoted. */
  sentence: string;
}

/*
  A sentence claims a commit changed something only when it says so.

  Naming a commit and a file in one sentence is not that claim. Measured on a real,
  correct record: "three attempts … failed (stated in fef3e2b and in the comment in
  components/landing/LandingScene.tsx)" cites the commit's message and the file's comment
  as two sources. Reading co-occurrence as a change claim marked a true record as
  contradicted, which is the failure this module exists to prevent. So the commit has to be
  the subject of a change verb ("fef3e2b (2026-09-16) added …"), or the object of one
  ("… was rewritten in 027f9b1", "… added in b1613b6").
*/
const CHANGED = 'added|changed|rewritten|modified|created|deleted|removed|updated|edited|replaced|introduced|moved|' +
  'renamed|reworked|refactored|fixed|touched|set|made|dropped|gained|lost|raised|lowered|split|reverted|restored|' +
  'extracted|widened|narrowed|converted|ported|deleted|emptied|truncated|cleaned';
const CHANGED_ACTIVE = 'added|changed|rewrote|modified|created|deleted|removed|updated|edited|replaced|introduced|moved|' +
  'renamed|reworked|refactored|fixed|touched|set|made|dropped|gave|raised|lowered|split|reverted|restored|extracted|' +
  'widened|narrowed|converted|ported|emptied|truncated|cleaned';
const claimsChange = (sentence: string, token: string): boolean => {
  const t = token.replace(/[^0-9a-f]/gi, '');
  // "was rewritten in C", "gained a third export in C": the verb, at most six words, then the commit.
  const passive = new RegExp(`\\b(?:${CHANGED})\\b(?:\\s+[^\\s.;()]+){0,6}?\\s+(?:in|by|with)\\s+(?:commit\\s+)?${t}`, 'i');
  const active = new RegExp(`\\b${t}[0-9a-f]*\\b\\s*(?:\\([^)]*\\)\\s*)?(?:(?:also|then|first|later)\\s+)?(?:${CHANGED_ACTIVE})\\b`, 'i');
  return passive.test(sentence) || active.test(sentence);
};

/** A hexadecimal token long enough to be a commit and containing a digit, so words are not commits. */
const COMMIT_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
/** A file-shaped token: an optional directory part, a name, and an extension starting with a letter. */
const FILE_RE = /(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;
/** URLs are not files, and their hosts look like them. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const baseName = (p: string): string => norm(p).split('/').pop() ?? p;

/**
 * The sentences of *texts* that name a commit and a file, where that commit changed none
 * of the files the sentence names.
 *
 * *recordFiles* are the record's own files: a bare file name in a sentence ("role.middleware.js")
 * counts as a mention when it is the name of one of them. A token with a directory part
 * counts as a mention whatever it is. *lookup* returns what the store holds for a commit,
 * or null when it holds nothing.
 */
export function findContradictions(
  texts: string[], recordFiles: string[], lookup: (hash: string) => CommitFacts | null,
): RecordContradiction[] {
  const own = recordFiles.map(norm);
  const ownBases = new Set(own.map(baseName));
  const out: RecordContradiction[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const raw of text.split(/(?<=[.;!?])\s+|\n+/)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const stripped = sentence.replace(URL_RE, ' ');

      const files = [...new Set((stripped.match(FILE_RE) ?? []).map(norm))]
        .filter((f) => f.includes('/') || ownBases.has(f));
      if (!files.length) continue;

      for (const token of new Set((stripped.match(COMMIT_RE) ?? []).map((t) => t.toLowerCase()))) {
        // Cited, not credited with a change: nothing for a file list to refute.
        if (!claimsChange(stripped, token)) continue;
        const commit = lookup(token);
        // Not held, or held without a file list: nothing to check the sentence against.
        if (!commit || !commit.changedFiles.length) continue;
        const changed = commit.changedFiles.map(norm);
        const touched = files.some((f) => changed.some((c) => sameFile(c, f)));
        if (touched) continue;
        const key = `${commit.shortHash}|${files.join(',')}|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ commit: commit.shortHash, files, changed: changed.slice(0, 4), sentence });
      }
    }
  }
  return out;
}

/** Whether a changed path is the file a sentence names: the same path, or the same name when the sentence gives no directory. */
function sameFile(changed: string, named: string): boolean {
  if (changed === named) return true;
  if (named.includes('/')) return changed.endsWith(`/${named}`);
  return baseName(changed) === named;
}

/** One line for a reader: what the record says, and what git shows. */
export function describeContradiction(c: RecordContradiction): string {
  const files = c.files.join(', ');
  const changed = c.changed.length ? c.changed.join(', ') : 'no file the store lists';
  return `names ${c.commit} with ${files}; git shows ${c.commit} did not change ${c.files.length > 1 ? 'any of them' : 'it'} ` +
    `(it changed ${changed})`;
}
