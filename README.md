# Strata

**Project memory for AI-assisted coding.** Strata remembers *why* your code is the way it is
(what changed, what was tried and failed, what rules a change must respect) and hands that to
your AI coding agent before it starts work, with every statement labelled by how far it can
be trusted.

---

## The problem

When you build software with an AI agent, the code survives but the reasoning disappears:
- why one approach was chosen;
- which approaches failed and why;
- which constraints a change must keep;
- what a past session already found out.

The next session, or the next model, starts from zero. It searches the code again, re-reads
git history, and sometimes repeats a mistake that was already made and fixed.

## What Strata does

Strata keeps a small, local memory inside your repository, built from three sources:
1. **Your git history:** which commits changed which files, and what each change replaced.
2. **A code index:** the functions and exports in each file, which files import which, and
   where things are called.
3. **Records:** short notes about intent, failed attempts, constraints and consequences. You
   or an agent write them, or Strata derives them from a Claude Code or Antigravity session.

When you give your agent a task, Strata builds a **context pack**: the target file's current
code, the commits that shaped it, whether each past decision still holds, related files, and
the relevant records. With Claude Code this is injected automatically before the agent reads
anything.

### Every statement carries a trust label

| Label | Meaning |
| :--- | :--- |
| `VERIFIED` | Read directly from git or the files on disk. |
| `DECLARED` | Someone wrote it down (a record, a commit message). A claim, not checked. |
| `INFERRED` | Strata's own reading of the evidence. |
| `UNKNOWN` | Not established. Strata says so instead of guessing. |

Each pack also opens with an **APPLICABILITY** line saying how far it can answer your
request:

| Class | Meaning |
| :--- | :--- |
| `SUPPORTED` | The target was named. Its code and history are VERIFIED and settled, and no unreliable record is about it. |
| `PARTIAL` | There is useful VERIFIED evidence, but something is missing, stale, cut or uncertain. The pack says what. |
| `LOW VALUE` | Little that is VERIFIED is about the target. The match was a guess. |
| `NOT APPLICABLE` | Nothing relevant was found. Strata does not invent a target. |

Strata also checks records against git. If a record says "commit X changed file Y" and git
shows it did not, the record is marked **CONTRADICTED by git** rather than presented as
fact. A record written before later changes to its files is flagged as out of date.

### What an agent receives (trimmed real output)

From a small demo repository with two commits and one record:

```text
# STRATA CONTEXT
Target: Why does src/webhooks/handler.ts ignore some deliveries?  (file, resolved by embedded_path)
Confidence: HIGH — explicit path

## APPLICABILITY: SUPPORTED
- why: named outright; code quoted; 2 target commit(s); 1 of 2 decision(s) settled; REC-1 on it (DECLARED)

## CURRENT BEHAVIOR  (what the code does now)
- src/webhooks/handler.ts — 6 lines, exports:  (VERIFIED, quoted from the working tree)
    src/webhooks/handler.ts:2  export function handleWebhook(id: string): boolean {
- used at:
    src/webhooks/router.ts:2  handleWebhook  (VERIFIED)

## HISTORICAL DECISIONS
- src/webhooks/handler.ts  —  decided in 2eceb96 (ignore duplicate webhook deliveries)
  STATUS: ACTIVE  (VERIFIED)
  HISTORICAL  (what used to be there) (VERIFIED):
    - return id.length > 0;
  CURRENT  (what replaced it, still present at HEAD) (VERIFIED):
    + if (seen.has(id)) return false;
    ...

## CONSTRAINTS  (recorded conditions a change must respect)
- (DECLARED) [REC-1] [ACTIVE] src/webhooks/handler.ts — UNVERIFIED CLAIM: "handleWebhook must stay idempotent"

## PREVIOUS ATTEMPTS
- (DECLARED) [REC-1] src/webhooks/handler.ts — UNVERIFIED CLAIM: "failed: Database row lock — too slow under load"
```

---

## How it works

```text
 git history ─┐                ┌──►  context pack  ──►  agent, per prompt
 code index ──┼──►  .strata/  ─┤     (labelled, sized       (Claude Code hook)
 records ─────┘    (local)     │      to a budget)
                               └──►  docs/strata/  ──►  every agent and every person
                                     DECISIONS.md          (plain Markdown, no setup)
                                     FLOW.md
```

- **Local:** everything lives in `.strata/` inside your repository. No server and no cloud.
  Delete `.strata/` and your project is untouched.
- **Records:** one Markdown file per decision in `.strata/records/` (`REC-14.md`), so you can
  read, edit, review and commit them like any document (see [Record files](#record-files)).
- **Database:** the SQLite database (`.strata/strata.db`) is a local cache and can be rebuilt.
- **Readable docs:** `docs/strata/DECISIONS.md` and `docs/strata/FLOW.md` are generated from
  the store, kept current automatically, and readable by any agent or person (see below).
- **Size:** packs are sized to fit a budget: 3,200 tokens by default from `strata context`,
  and at most 10,000 characters (about 2,400 tokens) through the Claude Code hook.

---

## Quick start

### Requirements

- **Node.js 22.13 or newer.** Strata uses Node's built-in SQLite; it is tested on Node 24.
  Node prints an "SQLite is an experimental feature" warning, which is harmless.
- **A git repository.**

### 1. Install Strata (once)

```bash
git clone https://github.com/Basant-creator/Strata.git
```

```bash
cd Strata && npm install && npm run build
```

Make the `strata` command available everywhere:

```bash
npm link
```

### 2. Set up your project, for your editors

Inside your project, which must be a git repository with at least one commit, name the
editors you use:

```bash
strata setup claude-code antigravity
```

That one command:
- initialises and indexes Strata if needed;
- writes `docs/strata/DECISIONS.md` and `docs/strata/FLOW.md`;
- adds Strata's local cache to `.gitignore` (`.strata/strata.db*`, `.strata/docs-state.json`).
  Commit `.strata/records/` and `docs/strata/`;
- installs a git `post-commit` hook that refreshes the index and the docs after every commit,
  and never fails a commit;
- wires each editor you named (table below).

It never overwrites what it did not write. Existing settings are merged, a settings file it
cannot parse is left alone and reported, and running it again changes nothing.

### 3. What each editor gets

| Editor | How Strata reaches its agent | Automatic? |
| :--- | :--- | :--- |
| **Claude Code** (`claude-code`) | A `UserPromptSubmit` hook in `.claude/settings.json`. Every prompt gets a context pack before the agent starts. | Yes, per prompt |
| **Antigravity** (`antigravity`) | An always-on rule, `.agents/rules/strata.md`. It tells the agent to read `docs/strata/` and run `strata context` before changing code. Antigravity has no per-prompt hook. Its session-start hook does receive the first prompt (checked on agy 1.5), but Strata does not install one yet, so the rule is what ships. | Yes, per session (the agent follows the rule) |
| **Any other agent** | `docs/strata/DECISIONS.md` and `FLOW.md` are plain files in the repository; point your agent at them, or use MCP (below). | Docs stay current; reading them is up to the agent |

Codex and Cursor are not wired yet. Codex has a prompt hook compatible with Claude Code's,
and Cursor can add context at session start, so both are planned.

The Claude Code hook never blocks your prompt: if Strata has nothing useful or something
goes wrong, it stays silent. It also skips Claude Code's own background-task notifications
and prompts that are only conversation ("yes, go ahead", "commit and push", "not yet"). Other
prompts that are not about code still get a pack; see the limitations below.

Before each pack the hook refreshes Strata's index, so commits and files added since the
last `strata index` are included. When nothing changed this costs a fraction of a second.
To stay fast it skips files whose size and modification time say they are unchanged, as
git does; `strata index` checks every file's content, so run it if a tool rewrote files
and set their times back. On a very large repository, add `--no-refresh` to the command
and run `strata index` yourself instead.

### 4. MCP, and pasting

For any agent that supports MCP, or when you want context by hand:
- **MCP:** run Strata's MCP server, `strata mcp`, from your
  project directory. The agent can then call these tools:

  | Tool | What it does |
  | :--- | :--- |
  | `strata_context` | Builds the context pack. |
  | `strata_explain` | Builds the human explanation. |
  | `strata_get_context` | Older record-only digest. |
  | `strata_explain_file` | Older record-only digest. |
  | `strata_record_change` | Writes a record. |

  The agent decides when to call them, so how much it gets depends on the agent.
- **Paste:** run `strata context "your task"` and paste the output into your prompt.

---

## The readable docs: DECISIONS.md and FLOW.md

The record files hold each decision as it was written; the database is a cache built from
them. These two files are the same knowledge, gathered for people and for any agent, with no
integration needed, and with what only git can tell (whether each decision still holds):

| File | What it holds |
| :--- | :--- |
| `docs/strata/DECISIONS.md` | Every recorded decision, oldest first: what was decided, why, what was tried and failed, the rules a change must keep, and a status git decides: `CURRENT`, `OUT OF DATE` (its files changed since), `CONTRADICTED BY GIT`, or `SUPERSEDED`. |
| `docs/strata/FLOW.md` | How the project evolved, from the first commit to now, grouped by month (or by week for a young project): what changed, where, and which decisions were made along the way. It then gives a blueprint of the project today: modules, how they connect, the most depended-on and most changed files, and the packages it uses. |

- **Labels:** every statement keeps Strata's trust labels. A record is shown as a claim
  (`DECLARED`); git facts are `VERIFIED`.
- **Deterministic:** no clock time and no machine paths, so regenerating changes nothing unless
  the project changed. They are safe to commit.
- **Updated automatically:** after every commit (the git hook), every record you save, and
  before every Claude Code prompt, but only when something they are built from changed.
  `strata docs` regenerates them by hand.
- **Generated:** don't edit them; change the record files instead.

### Record files

Each decision is a Markdown file, `.strata/records/<id>.md`, and that file is the real copy:
commit it, review it in a pull request, and edit it by hand when a decision needs correcting.

```markdown
---
id: REC-14
status: ACTIVE
recorded: 2026-10-15T18:44:12.123Z
author: Basant Bhushan
result: success
---

# Keep workflow talk out of the resolver

## Decided

Prompts that are only conversation get no context pack...

## Rules to keep

- A clause that names something outright is never removed
  - status: ACTIVE
  - confidence: DECLARED
```

- **Edits count:** the next refresh (any prompt, `strata index`, or a commit) reads every
  record file into the store, so a correction or a teammate's pulled record reaches the next
  pack and `DECISIONS.md`.
- **Strict:** a file that breaks the format is reported with its line number, by
  `strata index` and in the hook's log, and the store keeps the last good version. It is
  never skipped silently.
- **VERIFIED is Strata's:** the header lists a fingerprint of each item Strata itself marked
  `VERIFIED`. A `VERIFIED` typed by hand, or left on an item whose text was edited, is read as
  `DECLARED` and reported. This catches a mistaken label, not a forged one.
- **Older JSON records** still load. `strata migrate-records` rewrites them as Markdown.

---

## Daily use

| When | Do this |
| :--- | :--- |
| You make a change | Commit often, with clear messages. Git is half of Strata's memory. |
| After you commit, `git pull`, or make a big change | Nothing, if you use the Claude Code hook: it refreshes before every prompt. Before `strata context`, `explain`, `history` or MCP, run `strata index`. It only reprocesses what changed. |
| You make a decision, or something fails | Record it (below). This is the part git cannot remember. |
| After a Claude Code or Antigravity session | Optionally turn the session into a record with `strata derive`. |
| You want the big picture | Read `docs/strata/FLOW.md`, and `docs/strata/DECISIONS.md` for the reasons. |
| You want to understand a file | `strata explain <file>` or `strata history <file>` |
| You want to see what the agent will get | `strata context "your task"`. Check the APPLICABILITY line. |

**Recording a decision:**

```bash
strata record --intent "Ignore duplicate webhook deliveries" --files src/webhooks/handler.ts --attempt "Database row lock:failed:too slow under load" --constraint "handleWebhook must stay idempotent:DECLARED:ACTIVE"
```

Fields are separated by `:`, and text may contain colons too. The last field (a reason, a
description) keeps everything after it, labels such as `DECLARED` or `failed` are only read
as labels when spelled exactly, and URLs and `C:\` paths in an evidence reference stay whole.
Anywhere else, write `\:` for a colon that is part of the text.

**Deriving a record from a session transcript.** Strata reads what the session shows (the
files changed, the checks run and how they ended, what was refused) rather than asking the
agent, and the format is detected from the file:

```bash
# Claude Code: sessions are stored under ~/.claude/projects/...
strata derive path/to/session.jsonl --save

# Antigravity CLI: capture the stream, then derive. The stream does not carry the prompt,
# so pass it with --prompt-file to give the record its intent.
agy -p "$(cat task.txt)" --output-format stream-json > session.jsonl
strata derive session.jsonl --prompt-file task.txt --save
```

- An Antigravity edit is recorded by its path only: the stream does not say what changed.
- A check the permission layer refused did not run, so it neither passes nor fails the work.
- A file that is not a session stream, or is the other format from the one named with
  `--adapter`, is an error, not an empty record.

**Writing good records:**
- **Say why**, and what failed. The code already shows what.
- **Name commits and files accurately.** Strata checks "commit X changed file Y" against git
  and marks a wrong claim CONTRADICTED.
- **Replace stale records.** When code changes after a record was written, Strata flags the
  record as out of date. Write a new one instead of relying on the old.

### Commands

| Command | Purpose |
| :--- | :--- |
| `strata setup <editors...>` | One-step setup: init, index, docs, `.gitignore`, the post-commit hook, and each editor's integration (`claude-code`, `antigravity`; `--no-git-hook` to skip the hook). |
| `strata docs` | Write `docs/strata/DECISIONS.md` and `FLOW.md` now (`--if-present` updates only existing docs). |
| `strata init` | Set up Strata in a git repository (without editor wiring). |
| `strata index` | Build or refresh the code index and the commit cache (`--force` reindexes every file). |
| `strata status` | Show store and repository counts. |
| `strata record ...` | Write a record: intent, attempts, constraints, consequences, evidence. |
| `strata derive <transcript>` | Derive a record from a Claude Code or Antigravity session (`--save` to store it; `--prompt-file` when the stream lacks the prompt). |
| `strata migrate-records` | Rewrite JSON record files from older versions as Markdown. |
| `strata context "<task>"` | The pack an agent receives (`--symbol`, `--file` or `--task` to say what you mean; `--json` for raw). |
| `strata explain <target>` | For a person: what the code does now, the decisions behind it, whether they still hold, and what is unknown. |
| `strata history <target>` | Every commit that changed the target, oldest first, with each decision's status. |
| `strata hook user-prompt-submit` | The Claude Code hook (reads the prompt on stdin). |

---

## Benchmarks

Strata was measured by running the same questions with and without it.

| Agent | Questions | Tool calls | Cost | Correct answers |
| :--- | :--- | :--- | :--- | :--- |
| Claude Code, Claude Opus | History and "why" questions | about 21% fewer | about 7% lower | unchanged |
| Claude Code, Claude Opus | History questions on large public repositories | 20% to 25% fewer | 1% to 5% lower | unchanged |
| Antigravity, Gemini 3.8 Flash | Questions about a project's own history | 11% to 20% fewer | not measured | unchanged, all correct |
| Antigravity, Gemini 3.8 Flash | History questions on large public repositories | no consistent difference | not measured | unchanged |
| Claude Code, Claude Opus | Fixing bugs from real bug reports | no difference | no difference | unchanged |

**What the numbers mean:**
- **Less digging, same answers.** Strata cuts how much an agent searches before it answers,
  most on history and "why" questions. It has not been shown to make answers more correct:
  without it, the agent reached the same answers by reading git and the code.
- **Simple questions cost slightly more.** On "what does this file export?" the agent reads
  the file anyway, and the pack adds about 2,400 tokens.
- **Results vary by task.** Some history questions showed no saving, and stronger models made
  more of the pack than cheaper ones.
- **Records are not yet measured on their own.** Whether a record of what was tried and failed
  changes an agent's answer, beyond what git already holds, is untested.

---

## Language support

| Level | Languages | What Strata understands |
| :--- | :--- | :--- |
| **Full** | TypeScript and JavaScript using ES modules (`import`/`export`): `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | Functions, exports, imports, call sites, plus history and records |
| **Partial** | JavaScript using CommonJS (`require` / `module.exports`) | Files and declarations, but **no imports or exports**, so no code graph |
| **By path only** | `.json .prisma .sql .yaml .yml .toml .csv .graphql` | That the file exists and its git history; not its contents. One exception: the packages a `package.json` declares are indexed, so "upgrade phaser" reaches the manifest and its records |
| **Not covered** | Python, Go, Java, C#, Rust, PHP, HTML, CSS, Markdown and everything else | Nothing from the code itself. A request naming such a file gets no pack. |

For a new project, TypeScript or JavaScript with ES modules gets the most out of Strata.

---

## Drawbacks and known limitations

Strata states what it does not know, and so does this list.

- **Limited language support** (above). Python and most other languages are not understood
  yet.
- **Records about unindexed files are not delivered.** A record about a Python file, for
  example, will not reach a task about that file.
- **Records are claims.** Strata labels them DECLARED, including any evidence you attach,
  and checks one kind of claim against git ("commit X changed file Y"). It cannot detect a
  wrong claim about *what* a commit did to a file it really changed. It also cannot check
  commits older than the 200 it caches.
- **Only a rule or a whole record can be marked superseded.** A consequence has no status of
  its own. One that no longer holds is marked by a dated note at its end ("No longer holds
  (noted 2026-11-13): since …"), which packs keep when they shorten a long statement.
- **Plain words can mislead the target.** Requests are matched to files by paths, symbol
  names and words.
  - A precise request resolves exactly: "fix `handleWebhook` in src/webhooks/handler.ts".
  - A vague one ("fix the page") is a guess, and the pack says so (LOW / PARTIAL).
  - A package's name reaches `package.json` only when the request is about packages
    ("upgrade", "version", "install", "npm" and similar), so "react to clicks" stays about
    code. "update phaser" does not count: "update" is too often about code. Write
    "upgrade" or name `package.json`.
  - A value that exists only as text in the code is not in the symbol index. "Why does an
    unknown record id give TARGET_NOT_FOUND?" resolves by its plain words (to `record.ts`),
    not to the file that holds that value. Name a function or a file instead.
- **Prompts that are not about code still get a pack.** The Claude Code hook skips only
  prompts made entirely of conversation words. These still get a pack of about 2,400 tokens
  about files they never meant:
  - a status question ("what's the current status of the project?" matches a file named
    `status.ts`);
  - a commit request with an object ("Commit docs", "commit the indexer fix");
  - a short workflow step ("Start part C").

  This costs tokens; it has not been seen to make answers wrong.
- **Agents can still over-trust or over-read the pack.** Agents, with or without Strata,
  sometimes add motives or causes the evidence does not support. Strata labels its content,
  but cannot force a model to respect the labels.
- **Small cost on every prompt.** Through the Claude Code hook a pack is about 2,400 tokens
  even when the question is trivial.
- **Per-prompt context is Claude Code only.**
  - Antigravity gets an always-on rule, but its agent decides whether to follow it. It
    reliably reads the memory files, and runs `strata context` mainly when asked to.
  - Other agents get the docs files, and MCP or copy-paste.
  - Codex and Cursor setup is not built yet.
- **The docs are only as complete as the records.** `DECISIONS.md` lists what someone recorded.
  Unrecorded decisions appear in `FLOW.md` only as commit subjects, without reasons.
- **You must keep it fresh.** The Claude Code hook refreshes the index before every prompt;
  the other ways in (`strata context`, `explain`, `history`, MCP) read it as the last
  `strata index` left it. And record decisions: Strata cannot remember what nobody wrote down
  or committed.
- **Small known rough edges:**
  - a record can be reported as "not shown (budget)" while its text still appears;
  - instruction text in a prompt (such as "do not edit files") can occasionally be matched to
    a file by its words.
- **Early-stage software** (v0.1.0): tested with Claude Code (Claude Opus) and Antigravity
  (Gemini), on Windows. Results elsewhere may differ.

---

## Development

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

The test suite has more than 770 tests. Many build real git repositories, so each test is
allowed 30 seconds. `tests/known_limits.test.ts` reproduces the limits listed above: each
wanted behaviour is a test marked as expected to fail, which starts failing on the day a
change removes the limit.

## License

Source-available, view only. You may read the code and run Strata for your own use; you may
not copy, modify or redistribute it. See [LICENSE](LICENSE).
