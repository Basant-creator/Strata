import { describe, it, expect, afterEach } from 'vitest';
import { createStrataServer, STRATA_MCP_TOOLS } from '../src/mcp/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('Strata MCP Server Protocol', () => {
  let client: Client;
  let serverHandler: { close: () => void };

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    if (serverHandler) {
      serverHandler.close();
    }
  });

  it('lists all registered Strata MCP tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server, handler } = createStrataServer();
    serverHandler = handler;

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools).toHaveLength(STRATA_MCP_TOOLS.length);

    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain('strata_get_context');
    expect(toolNames).toContain('strata_explain_file');
    expect(toolNames).toContain('strata_record_change');
  });

  it('handles tool execution for strata_get_context via MCP protocol', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server, handler } = createStrataServer();
    serverHandler = handler;

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'strata_get_context',
      arguments: { task: 'refactor auth flow' },
    });

    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Strata context for');
  });
});
