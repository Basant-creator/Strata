import { Command } from 'commander';
import { StrataService } from '../../records/service.js';

/**
 * `strata index` — build or refresh the code graph and the commit cache.
 *
 * Kept separate from `strata init` because the two have different lifetimes. `init` is
 * once per repository: it creates the store. The graph tracks the working tree and the
 * cache tracks git, and both go stale on every edit or commit, so they need a cheap
 * command that can be re-run often. By default it only re-parses files whose bytes
 * actually moved, and re-reads the commit cache only when HEAD has moved.
 */
export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Build or refresh the code graph and commit cache used by "strata context"')
    .option('--force', 'reindex every file, ignoring content hashes')
    .option('--json', 'emit statistics as JSON')
    .action((options) => {
      const service = new StrataService();
      try {
        if (!service.isInitialized()) {
          console.error('Strata is not initialized. Run "strata init" first.');
          process.exit(1);
        }

        const stats = service.indexCode({ force: !!options.force });

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        console.log(`Indexed ${stats.filesIndexed} file(s) in ${stats.durationMs} ms`);
        console.log(`  scanned        : ${stats.filesScanned}`);
        console.log(`  unchanged      : ${stats.filesUnchanged}`);
        if (stats.filesRemoved) console.log(`  removed        : ${stats.filesRemoved}`);
        console.log(`  symbols        : ${stats.symbols}`);
        console.log(`  imports        : ${stats.imports} (${stats.importsResolved} resolved in-repo)`);
        console.log(`  references     : ${stats.references} (${stats.referencesResolved} bound to a file)`);
        console.log(`  file<->commit  : ${stats.fileCommitEdges} edge(s)`);
        console.log(`  git commits    : ${stats.commitsCached} cached` +
          (stats.commitsRefreshed ? ' (re-read from git)' : ' (HEAD unchanged, not re-read)'));
        if (stats.recordsUpdated) console.log(`  records        : ${stats.recordsUpdated} read from .strata/records/`);
        for (const p of stats.recordProblems) console.log(`  record problem : ${p.file}: ${p.message}`);
        if (stats.imports > stats.importsResolved) {
          console.log(
            `\nUnresolved imports are package imports or paths with no file behind them; ` +
            `they are stored with resolution=UNKNOWN rather than guessed.`
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Indexing failed: ${message}`);
        process.exit(1);
      } finally {
        service.close();
      }
    });
}
