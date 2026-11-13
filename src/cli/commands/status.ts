import { Command } from 'commander';
import { StrataService } from '../../records/service.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show Strata status and repository metrics')
    .action(() => {
      try {
        const service = new StrataService();
        const status = service.getStatus();

        if (!status.initialized) {
          console.log('⚪ Strata is not initialized in this repository.');
          console.log('Run "npx strata init" to get started.');
          return;
        }

        console.log('📊 Strata Status:');
        console.log(`  Initialized:      Yes`);
        console.log(`  Repository Root:  ${status.repoRoot}`);
        console.log(`  Strata Path:      ${status.strataDir}`);
        console.log(`  Git Branch:       ${status.currentBranch}`);
        console.log(`  Git HEAD:         ${status.headCommit ? status.headCommit.substring(0, 7) : 'none'}`);
        console.log(`  Strata Records:   ${status.totalRecords}`);
        console.log(`  Cached Commits:   ${status.totalCachedCommits}`);
        service.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Status check failed: ${message}`);
        process.exit(1);
      }
    });
}
