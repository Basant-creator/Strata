import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { addHumanViewOptions, runHumanView } from './human-view.js';

export function registerHistoryCommand(program: Command): void {
  addHumanViewOptions(
    program
      .command('history <target>')
      .description('How this code changed: every commit that changed it, oldest first, with each decision\'s status, ' +
                   'the development memory about it, deleted evidence, provenance and what is unknown')
      .option('--legacy', 'the original record-and-commit list for a file'),
  ).action((target: string, options: Record<string, unknown>) => {
    if (options['legacy']) return legacyHistory(target);
    runHumanView(target, 'history', options);
  });
}

/** The pre-engine timeline, kept for anyone scripting against its output. */
function legacyHistory(file: string): void {
  try {
    const service = new StrataService();
    if (!service.isInitialized()) {
      console.error('❌ Strata is not initialized. Run "npx strata init" first.');
      process.exit(1);
    }

    const history = service.getHistory(file);

    console.log(`\n📜 History for: ${history.filePath}`);
    console.log(`📊 Total Strata Records: ${history.totalRecords} | Git Commits: ${history.totalCommits}\n`);

    if (history.timeline.length === 0) {
      console.log('⚪ No history or commits found for this file.');
      service.close();
      return;
    }

    for (const item of history.timeline) {
      const date = new Date(item.timestamp).toISOString().split('T')[0];
      if (item.type === 'strata_record') {
        console.log(`🔹 [STRATA RECORD: ${item.id}] ${date}`);
        console.log(`   Author: ${item.author}${item.agent ? ` | Assisted by: ${item.agent}` : ''}`);
        console.log(`   Intent: ${item.intent} [${item.intentConfidence}]`);
        if (item.record?.attempts && item.record.attempts.length > 0) {
          for (const a of item.record.attempts) {
            const icon = a.status === 'succeeded' ? '✅' : a.status === 'failed' ? '❌' : '⚠️';
            console.log(`   ${icon} Attempt: ${a.approach}${a.failureReason ? ` (${a.failureReason})` : ''}`);
          }
        }
        if (item.record?.result.summary) {
          console.log(`   Result: ${item.record.result.summary}`);
        }
      } else {
        console.log(`🔸 [GIT COMMIT: ${item.id}] ${date}`);
        console.log(`   Author: ${item.author}`);
        console.log(`   Message: ${item.titleOrMessage}`);
      }
      console.log('');
    }

    service.close();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ History retrieval failed: ${message}`);
    process.exit(1);
  }
}
