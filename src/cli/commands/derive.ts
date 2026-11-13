import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { deriveRecord } from '../../derive/derive.js';
import { DerivedFinding, LineEndingInspection } from '../../derive/types.js';

const SEVERITY_MARK: Record<DerivedFinding['severity'], string> = {
  blocking: '!!',
  notable: ' !',
  informational: '  ',
};

function printFindings(findings: DerivedFinding[]): void {
  if (findings.length === 0) {
    console.log('No findings detected. The detectors did not fire; that is not the same as a clean session.');
    return;
  }
  console.log(`\n${findings.length} finding(s):\n`);
  for (const finding of findings) {
    console.log(`${SEVERITY_MARK[finding.severity]} [${finding.kind}] ${finding.summary}`);
    if (finding.detail) console.log(`      ${finding.detail}`);
    console.log(`      transcript events: ${finding.eventIndices.join(', ')}`);
    if (finding.quote) console.log(`      > ${finding.quote}`);
    console.log('');
  }
}

function printInspection(inspection: LineEndingInspection): void {
  console.log(
    `Line-ending inspection: checked=${inspection.checked} ` +
      `reference=${inspection.reference} confidence=${inspection.confidence}`,
  );
  for (const item of inspection.evidence) {
    console.log(`      [${item.basis}] event ${item.index}: ${item.quote}`);
  }
}

export function registerDeriveCommand(program: Command): void {
  program
    .command('derive <transcript>')
    .description('Derive a development context record by reading an agent session transcript')
    .option('--adapter <name>', 'Transcript format: claude-code, antigravity, or auto to detect it', 'auto')
    .option('--intent <intent>', 'Override the intent taken from the task prompt')
    .option(
      '--prompt-file <path>',
      'Task definition to take the intent from, when the transcript does not carry the prompt',
    )
    .option('--title <title>', 'Override the derived title')
    .option('--author <name>', 'Author name recorded on the derived record')
    .option('--changed-file <path...>', 'Authoritative changed-file paths (e.g. from git status)')
    .option('--save', 'Write the derived record into the Strata store')
    .option('--json', 'Print the derived record as JSON instead of a summary')
    .option('--metrics', 'Print the secondary metrics as JSON instead of a summary')
    .option('--out <path>', 'Write the derived record JSON to a file')
    .action((transcriptPath: string, options) => {
      try {
        const resolved = path.resolve(transcriptPath);
        if (!fs.existsSync(resolved)) {
          console.error(`❌ Transcript not found: ${resolved}`);
          process.exit(1);
        }

        const raw = fs.readFileSync(resolved, 'utf-8');
        // The store's repository, so paths the session wrote map onto the files it holds.
        const service = new StrataService();
        const { record, findings, transcript, inspection, work, observedAt } = deriveRecord(
          raw,
          options.adapter,
          path.basename(resolved),
          {
            intent: options.intent,
            title: options.title,
            author: options.author ? { name: options.author } : undefined,
            changedFiles: options.changedFile ?? [],
            prompt: options.promptFile
              ? fs.readFileSync(path.resolve(options.promptFile), 'utf-8')
              : undefined,
            promptSource: options.promptFile ? path.basename(options.promptFile) : undefined,
            repoRoot: service.getRepoRoot(),
          },
        );

        if (options.out) {
          fs.writeFileSync(path.resolve(options.out), JSON.stringify(record, null, 2), 'utf-8');
          console.log(`Derived record written to ${options.out}`);
        }

        if (options.metrics) {
          console.log(JSON.stringify({ line_ending_inspection: inspection }, null, 2));
        } else if (options.json) {
          console.log(JSON.stringify(record, null, 2));
        } else {
          console.log(`\nTranscript: ${transcript.source}`);
          console.log(`Adapter:    ${transcript.adapter}`);
          console.log(`Events:     ${transcript.events.length}`);
          console.log(`Result:     ${record.result.status}`);
          console.log(`Record id:  ${record.id} (stable: the same session always derives the same id)`);
          console.log(`Memory:     ${work.attempts.length} change attempt(s), ${record.reasons?.length ?? 0} stated ` +
            `reason(s), ${record.constraints?.length ?? 0} constraint(s), files: ` +
            `${record.files.map((f) => f.path).join(', ')}`);
          printInspection(inspection);
          printFindings(findings);
        }

        if (options.save) {
          if (!service.isInitialized()) {
            console.error('❌ Strata is not initialized. Run "npx strata init" first.');
            process.exit(1);
          }
          const { record: saved, outcome } = service.saveDerivedRecord(record, { observedAt });
          console.log(`Saved as ${saved.id} (${outcome})`);
        }
        service.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Derivation failed: ${message}`);
        process.exit(1);
      }
    });
}
