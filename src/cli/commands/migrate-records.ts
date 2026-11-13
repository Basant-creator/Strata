import { Command } from 'commander';
import { StrataService } from '../../records/service.js';

/**
 * `strata migrate-records` — rewrite the JSON record files as Markdown.
 *
 * Records are `.strata/records/<id>.md` now (see `src/records/markdown.ts`). JSON files
 * from before keep loading, and any record saved again is written as Markdown; this
 * converts the rest in one step, so the change can be reviewed and committed as one.
 */
export function registerMigrateRecordsCommand(program: Command): void {
  program
    .command('migrate-records')
    .description('Rewrite the JSON record files in .strata/records/ as Markdown')
    .action(() => {
      const service = new StrataService();
      try {
        if (!service.isInitialized()) {
          console.error('Strata is not initialized. Run "strata init" first.');
          process.exit(1);
        }
        const { migrated, problems } = service.migrateRecordFiles();
        for (const id of migrated) console.log(`migrated  .strata/records/${id}.json -> ${id}.md`);
        for (const p of problems) console.error(`problem   ${p.file}: ${p.message}`);
        if (!migrated.length && !problems.length) console.log('No JSON record files to migrate.');
        if (problems.length) process.exitCode = 1;
      } catch (err: unknown) {
        console.error(`strata migrate-records failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        service.close();
      }
    });
}
