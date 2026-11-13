import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';

describe('Strata End-to-End Workflow', () => {
  const testRepoDir = path.join(process.cwd(), '.test_repo_e2e');
  let service: StrataService;
  let mcpHandler: StrataMCPHandler;

  beforeAll(() => {
    // Set up test sandbox directory
    if (fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize Strata in sandbox
    service = new StrataService(testRepoDir);
  });

  afterAll(() => {
    service.close();
    if (mcpHandler) {
      mcpHandler.close();
    }
    if (fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  it('Step 1 & 2: Initializes .strata/ and SQLite database', () => {
    const initResult = service.init();
    expect(fs.existsSync(initResult.strataDir)).toBe(true);

    const status = service.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.totalRecords).toBe(0);
  });

  it('Step 3: Creates a structured Strata record with intent, attempts, and evidence', () => {
    const created = service.recordChange({
      title: 'Implement distributed locking',
      intent: 'Prevent concurrent webhook replay',
      intentConfidence: 'DECLARED',
      author: {
        name: 'Basant Bhushan',
        email: 'basant@example.com',
        type: 'human',
      },
      agent: {
        name: 'Claude Code',
        model: 'claude-3-7-sonnet',
      },
      files: [
        { path: 'src/webhook/handler.ts', changeType: 'modify' },
        { path: 'src/webhook/lock.ts', changeType: 'add' },
      ],
      attempts: [
        {
          sequence: 1,
          approach: 'Postgres SELECT FOR UPDATE',
          status: 'failed',
          failureReason: 'DB connection pool exhaustion',
          confidence: 'VERIFIED',
        },
        {
          sequence: 2,
          approach: 'Redis Redlock with 10s TTL',
          status: 'succeeded',
          confidence: 'VERIFIED',
        },
      ],
      evidence: [
        { type: 'issue', reference: 'ISSUE-42', confidence: 'VERIFIED' },
        { type: 'benchmark', reference: 'BENCH-101', description: 'Passed 1000 rps stress test', confidence: 'VERIFIED' },
      ],
      consequences: [
        'Requires REDIS_URL environment variable',
      ],
      result: {
        status: 'success',
        summary: 'All unit and integration tests passed (50/50)',
      },
    });

    expect(created.id).toBe('REC-1');
    expect(created.files).toHaveLength(2);

    // Verify the record file was also written, as Markdown, to .strata/records/REC-1.md
    const recordFile = path.join(testRepoDir, '.strata', 'records', 'REC-1.md');
    expect(fs.existsSync(recordFile)).toBe(true);
    expect(fs.existsSync(path.join(testRepoDir, '.strata', 'records', 'REC-1.json'))).toBe(false);

    const status = service.getStatus();
    expect(status.totalRecords).toBe(1);
  });

  it('Step 4: Queries file history timeline', () => {
    const history = service.getHistory('src/webhook/handler.ts');

    expect(history.filePath).toBe('src/webhook/handler.ts');
    expect(history.totalRecords).toBe(1);
    expect(history.timeline).toHaveLength(1);
    expect(history.timeline[0]?.titleOrMessage).toBe('Implement distributed locking');
    expect(history.timeline[0]?.agent).toContain('Claude Code');
  });

  it('Step 5: Generates concise evidence-backed explanation', () => {
    const explanation = service.explainFile('src/webhook/handler.ts');

    expect(explanation.overallConfidence).toBe('DECLARED');
    expect(explanation.why.intent).toBe('Prevent concurrent webhook replay');
    expect(explanation.who.authors).toContain('Basant Bhushan');
    expect(explanation.who.agents[0]).toContain('Claude Code');
    expect(explanation.how.approaches).toHaveLength(2);
    expect(explanation.rawText).toContain('## WHY (Intent)');
    expect(explanation.rawText).toContain('## HOW (Attempts & Decisions)');
    expect(explanation.rawText).toContain('[FAILED] Postgres SELECT FOR UPDATE -> DB connection pool exhaustion');
    expect(explanation.rawText).toContain('[SUCCEEDED] Redis Redlock with 10s TTL');
    expect(explanation.rawText).toContain('## EVIDENCE [VERIFIED]');
    expect(explanation.rawText).toContain('issue: ISSUE-42');
  });

  it('Step 6: Handles MCP tool calls cleanly', async () => {
    mcpHandler = new StrataMCPHandler(testRepoDir);

    // Test strata_get_context
    const contextRes = await mcpHandler.handleToolCall('strata_get_context', {
      task: 'Fix webhook replay',
      files: ['src/webhook/handler.ts'],
    });
    expect(contextRes.content[0]?.text).toContain('Strata context for');
    expect(contextRes.content[0]?.text).toContain('Postgres SELECT FOR UPDATE');

    // Test strata_explain_file
    const explainRes = await mcpHandler.handleToolCall('strata_explain_file', {
      filePath: 'src/webhook/lock.ts',
    });
    expect(explainRes.content[0]?.text).toContain('Strata Provenance Explanation');
    expect(explainRes.content[0]?.text).toContain('Prevent concurrent webhook replay');
  });
});
