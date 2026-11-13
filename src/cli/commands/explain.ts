import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { addHumanViewOptions, runHumanView } from './human-view.js';

export function registerExplainCommand(program: Command): void {
  addHumanViewOptions(
    program
      .command('explain <target>')
      .description('Why this code is like this: what it does now, the decisions that shaped it and whether they ' +
                   'still hold, what was tried before, constraints, consequences, evidence and what is unknown')
      .option('--legacy', 'the original record-only explanation for a file'),
  ).action((target: string, options: Record<string, unknown>) => {
    if (options['legacy']) return legacyExplain(target);
    runHumanView(target, 'explain', options);
  });
}

/** The pre-engine explanation, kept for anyone scripting against its output. */
function legacyExplain(file: string): void {
  try {
    const service = new StrataService();
    if (!service.isInitialized()) {
      console.error('❌ Strata is not initialized. Run "npx strata init" first.');
      process.exit(1);
    }

    const explanation = service.explainFile(file);
    console.log(`\n${explanation.rawText}\n`);
    service.close();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Explain failed: ${message}`);
    process.exit(1);
  }
}
