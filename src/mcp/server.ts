import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StrataService } from '../records/service.js';
import { CreateRecordInput } from '../schema/types.js';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const STRATA_MCP_TOOLS: MCPToolDefinition[] = [
  {
    name: 'strata_get_context',
    description: 'Retrieve minimum sufficient development context (intent, previous failed attempts, constraints, evidence) for a specific coding task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the coding task or bug to fix',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of relevant file paths if known',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'strata_explain_file',
    description: 'Generate an evidence-backed explanation of why a file exists, its evolution, and past architectural decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path of the file to explain',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'strata_record_change',
    description: 'Record development provenance and intent after completing a task or attempting a solution.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Brief summary of the change' },
        intent: { type: 'string', description: 'Why the change was made' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              changeType: { type: 'string', enum: ['add', 'modify', 'delete', 'rename'] },
            },
            required: ['path', 'changeType'],
          },
        },
        attempts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              approach: { type: 'string' },
              status: { type: 'string', enum: ['succeeded', 'failed', 'abandoned', 'superseded'] },
              failureReason: { type: 'string' },
            },
            required: ['approach', 'status'],
          },
        },
        evidence: {
          type: 'array',
          description: 'Stored as DECLARED: Strata records it as your claim and does not check it.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['git_commit', 'diff', 'test_run', 'issue', 'benchmark', 'log', 'other'] },
              reference: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['type', 'reference'],
          },
        },
        consequences: {
          type: 'array',
          description:
            'Effects this change left behind. A bare string is accepted and read as a ' +
            'DECLARED statement; give confidence and evidence to say more.',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  statement: { type: 'string' },
                  confidence: { type: 'string', enum: ['VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN'] },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['statement'],
              },
            ],
          },
        },
        constraints: {
          type: 'array',
          description:
            'Conditions any later change still has to respect. Distinct from intent: ' +
            'intent is what this change was for, a constraint is what the next one must ' +
            'honour. Record one only where something supports it.',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string' },
              confidence: { type: 'string', enum: ['VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN'] },
              evidence: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', enum: ['ACTIVE', 'SUPERSEDED', 'UNKNOWN'] },
            },
            required: ['statement'],
          },
        },
        symbols: {
          type: 'array',
          description: 'Symbols this memory is about, where the change names them.',
          items: { type: 'string' },
        },
        status: {
          type: 'string',
          enum: ['ACTIVE', 'SUPERSEDED', 'UNKNOWN'],
          description: 'Whether this memory still describes the code. Omit if unsure.',
        },
        supersededBy: {
          type: 'string',
          description: 'Record id that replaced this one, if any.',
        },
        result: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['success', 'failure', 'partial', 'in_progress', 'unknown'] },
            summary: { type: 'string' },
          },
          required: ['status'],
        },
        agent: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            model: { type: 'string' },
          },
          required: ['name'],
        },
      },
      required: ['title', 'intent', 'files', 'result'],
    },
  },
  {
    name: 'strata_context',
    description:
      'Assemble a compact, evidence-backed development context pack for a task, file or symbol. ' +
      'Resolves the target, expands its code neighbourhood, attaches the commits that touched it ' +
      'and any Strata records about it, and returns the result under a hard token budget. ' +
      'Prefer this over exploring the repository manually: it is designed to remove the ' +
      'read-file / grep / git-log loop needed to reconstruct why code looks the way it does. ' +
      'Every historical statement carries provenance (VERIFIED / DECLARED / INFERRED / UNKNOWN); ' +
      'UNKNOWN means Strata holds no evidence, not that nothing happened. ' +
      'The pack opens with its applicability — SUPPORTED, PARTIAL, LOW VALUE or NOT APPLICABLE — and ' +
      'the findings that decided it; that block is not counted in the budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A task description, a file path, or a symbol name.',
        },
        targetType: {
          type: 'string',
          enum: ['file', 'symbol', 'task'],
          description: 'Optional hint. Omit to let Strata resolve the query itself.',
        },
        depth: {
          type: 'number',
          description: 'Graph expansion depth, 0-3. Defaults to 1 (directly connected only).',
        },
        maxTokens: {
          type: 'number',
          description: 'Hard output budget. Defaults to 1800.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text (default) is the rendered pack; json is the structured pack.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'strata_explain',
    description:
      'Explain why code is the way it is, for a developer: what it does now, every change to it and ' +
      'whether each still holds (ACTIVE / SUPERSEDED / UNKNOWN), recorded development memory, previous ' +
      'attempts, constraints, consequences, deleted evidence, provenance and what is unknown. ' +
      'view "explain" leads with a short answer; view "history" leads with the commit timeline. ' +
      'Nothing is capped. Every statement keeps its provenance; DECLARED claims are quoted, never restated as fact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A file path, a symbol name, a directory, or a description in words.',
        },
        view: {
          type: 'string',
          enum: ['explain', 'history'],
          description: 'explain (default) or history.',
        },
        targetType: {
          type: 'string',
          enum: ['file', 'symbol', 'task'],
          description: 'Optional hint. Omit to let Strata resolve the query itself.',
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text (default) is the rendered view; json is the structured pack.',
        },
      },
      required: ['query'],
    },
  },
];

/** Tools that mutate the store. Excluded when the server runs read-only. */
const WRITE_TOOLS = new Set(['strata_record_change']);

/**
 * Whether this process should expose write tools.
 *
 * `strata_record_change` carries the largest input schema of the three by a wide margin,
 * and a consumer that only reads context pays for it on every request without ever calling
 * it. Set STRATA_READONLY=1 to serve the retrieval surface alone.
 */
export function isReadOnly(): boolean {
  const v = (process.env['STRATA_READONLY'] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** The tool definitions this process advertises, after the read-only filter. */
export function getEnabledTools(): MCPToolDefinition[] {
  return isReadOnly()
    ? STRATA_MCP_TOOLS.filter((t) => !WRITE_TOOLS.has(t.name))
    : STRATA_MCP_TOOLS;
}

export class StrataMCPHandler {
  private service: StrataService;

  constructor(repoRoot?: string) {
    this.service = new StrataService(repoRoot);
  }

  public async handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (name) {
      case 'strata_get_context': {
        const task = String(args['task'] || '');
        const files = Array.isArray(args['files']) ? (args['files'] as string[]) : [];
        const result = this.service.getContext(task, files);
        return {
          content: [{ type: 'text', text: result.formattedContext }],
        };
      }
      case 'strata_explain_file': {
        const filePath = String(args['filePath'] || '');
        const result = this.service.explainFile(filePath);
        return {
          content: [{ type: 'text', text: result.rawText }],
        };
      }
      case 'strata_context': {
        const query = String(args['query'] || '');
        const pack = this.service.getContextPack(query, {
          depth: typeof args['depth'] === 'number' ? (args['depth'] as number) : undefined,
          maxTokens: typeof args['maxTokens'] === 'number' ? (args['maxTokens'] as number) : undefined,
          targetType: args['targetType'] as 'file' | 'symbol' | 'task' | undefined,
        });
        const asJson = String(args['format'] || 'text') === 'json';
        return {
          content: [{
            type: 'text',
            text: asJson ? JSON.stringify(pack, null, 2) : this.service.renderAgentContext(pack),
          }],
        };
      }
      case 'strata_explain': {
        const query = String(args['query'] || '');
        const view = String(args['view'] || 'explain') === 'history' ? 'history' : 'explain';
        const { pack, text } = this.service.humanView(query, view, {
          targetType: args['targetType'] as 'file' | 'symbol' | 'task' | undefined,
        });
        const asJson = String(args['format'] || 'text') === 'json';
        return {
          content: [{ type: 'text', text: asJson ? JSON.stringify(pack, null, 2) : text }],
        };
      }
      case 'strata_record_change': {
        if (isReadOnly()) {
          throw new Error('strata_record_change is disabled: this server is running read-only');
        }
        const record = this.service.recordChange(args as unknown as CreateRecordInput);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully recorded Strata change ${record.id}: "${record.title}". Intent: ${record.intent}`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown Strata tool: ${name}`);
    }
  }

  public close(): void {
    this.service.close();
  }
}

export function createStrataServer(repoRoot?: string): { server: Server; handler: StrataMCPHandler } {
  const handler = new StrataMCPHandler(repoRoot);
  const server = new Server(
    {
      name: 'strata',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getEnabledTools(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handler.handleToolCall(name, (args as Record<string, unknown>) ?? {});
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return { server, handler };
}

export async function startServer(repoRoot?: string): Promise<void> {
  const { server } = createStrataServer(repoRoot);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('Strata MCP server running on stdio');
}

function isDirectExecution(): boolean {
  if (process.env['VITEST']) return false;
  // The release bundle puts this file inside the CLI, where argv[1] is the bundle itself.
  if (process.env.STRATA_BUNDLED) return false;
  if (!process.argv[1]) return false;
  try {
    const currentFilePath = fileURLToPath(import.meta.url).toLowerCase();
    const executedFilePath = path.resolve(process.argv[1]).toLowerCase();
    if (currentFilePath === executedFilePath) return true;
    if (executedFilePath + '.js' === currentFilePath || executedFilePath + '.ts' === currentFilePath) {
      return true;
    }
    const normalizedExecuted = executedFilePath.replace(/\\/g, '/');
    if (normalizedExecuted.endsWith('/mcp/server.js') || normalizedExecuted.endsWith('/mcp/server.ts')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

if (isDirectExecution()) {
  startServer().catch((error: unknown) => {
    console.error('Fatal error starting Strata MCP server:', error);
    process.exit(1);
  });
}
