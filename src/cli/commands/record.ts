import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import {
  CreateRecordInput,
  Attempt,
  Evidence,
  FileChange,
  ResultStatus,
} from '../../schema/types.js';
import { parseAttempt, parseConstraint, parseEvidence, parseFailedAttempt } from '../record-fields.js';

/** How the colon-separated options read text that contains colons; see record-fields.ts. */
const COLON_NOTE = 'the last field keeps any colons; write \\: for a literal colon elsewhere';

export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description('Record development context, intent, attempts, and outcomes')
    .requiredOption('-i, --intent <intent>', 'Why the change was made (intent)')
    .option('-t, --title <title>', 'Short title of the change (defaults to intent)')
    .option('-f, --files <files...>', 'Changed or affected files')
    .option('--author <name>', 'Author name')
    .option('--author-email <email>', 'Author email')
    .option('--agent <name>', 'AI agent or tool name (e.g. Claude Code, Cursor, Antigravity)')
    .option('--model <model>', 'AI model identifier (e.g. claude-3-7-sonnet, gpt-4o)')
    .option('--attempt <attempt...>',
            `Approach attempted in format "approach:status:failureReason" (${COLON_NOTE})`)
    .option('--failed-attempt <attempt...>',
            `Failed approach in format "approach:failureReason" (${COLON_NOTE})`)
    .option('--evidence <evidence...>',
            `Evidence in format "type:reference:description" (${COLON_NOTE}; URLs and C:\\ paths are kept whole)`)
    .option('--consequence <consequence...>', 'Follow-up consequences this change left behind')
    .option('--constraint <constraint...>',
            `Condition a later change must respect, as "statement:confidence:status" (labels are optional; the statement keeps any colons)`)
    .option('--symbol <symbol...>', 'Symbols this memory is about')
    .option('--status <status>', 'Whether this memory still holds: ACTIVE | SUPERSEDED | UNKNOWN')
    .option('--result <status>', 'Result status: success | failure | partial | in_progress', 'success')
    .option('--result-summary <summary>', 'Summary of results, test counts, or benchmarks')
    .action((options) => {
      try {
        const constraints = ((options.constraint ?? []) as string[])
          .map(parseConstraint)
          .filter((c) => c.statement.length > 0);

        const service = new StrataService();
        if (!service.isInitialized()) {
          console.error('❌ Strata is not initialized. Run "npx strata init" first.');
          process.exit(1);
        }

        const files: FileChange[] = [];
        if (options.files && options.files.length > 0) {
          for (const rawFile of options.files) {
            // Support comma-separated strings inside array
            const parts = rawFile.split(',');
            for (const p of parts) {
              const trimmed = p.trim();
              if (trimmed) {
                files.push({
                  path: trimmed,
                  changeType: 'modify',
                });
              }
            }
          }
        }

        // If no files specified, default to modified files from working tree or placeholder
        if (files.length === 0) {
          console.error('❌ At least one file must be specified with --files <path>.');
          process.exit(1);
        }

        const attempts: Attempt[] = [
          ...((options.attempt ?? []) as string[]).map(parseAttempt),
          ...((options.failedAttempt ?? []) as string[]).map(parseFailedAttempt),
        ];

        const evidence: Evidence[] = [];
        for (const raw of (options.evidence ?? []) as string[]) {
          const parsed = parseEvidence(raw);
          if (parsed.warning) console.error(`⚠️  ${parsed.warning}`);
          evidence.push(parsed.evidence);
        }

        const consequences: string[] = options.consequence || [];

        const author = options.author
          ? {
              name: options.author,
              email: options.authorEmail,
              type: 'human' as const,
            }
          : undefined;

        const recordInput: CreateRecordInput = {
          title: options.title || options.intent.substring(0, 80),
          intent: options.intent,
          intentConfidence: 'DECLARED',
          author,
          agent: options.agent
            ? {
                name: options.agent,
                model: options.model,
              }
            : undefined,
          files,
          attempts,
          evidence,
          consequences,
          constraints,
          symbols: (options.symbol ?? []) as string[],
          ...(['ACTIVE', 'SUPERSEDED', 'UNKNOWN'].includes(options.status)
            ? { status: options.status as 'ACTIVE' | 'SUPERSEDED' | 'UNKNOWN' } : {}),
          result: {
            status: options.result as ResultStatus,
            summary: options.resultSummary,
          },
        };

        const saved = service.recordChange(recordInput);

        console.log(`✅ Strata record created: ${saved.id}`);
        console.log(`📌 Intent: ${saved.intent}`);
        console.log(`📁 Files: ${saved.files.map((f) => f.path).join(', ')}`);
        if (saved.agent) {
          console.log(`🤖 Agent: ${saved.agent.name}${saved.agent.model ? ` (${saved.agent.model})` : ''}`);
        }
        if (saved.attempts.length > 0) {
          console.log(`💡 Attempts: ${saved.attempts.length} approaches recorded`);
        }
        if (saved.result.summary) {
          console.log(`🏁 Result: ${saved.result.summary}`);
        }

        service.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Record creation failed: ${message}`);
        process.exit(1);
      }
    });
}
