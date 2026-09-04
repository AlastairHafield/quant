import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBackendMcpServer } from './server.js';

// Stateless mode (sessionIdGenerator: undefined) — a fresh server+transport
// per request is the documented pattern for a simple API-style MCP server
// with no need for session continuity between calls, per the SDK's own
// simpleStatelessStreamableHttp example.
//
// No auth on this endpoint, same as every existing route in routes.js —
// not a new gap, just not a new fix either. Worth revisiting alongside the
// rest of this API's security posture, not in isolation just because this
// happens to be the newest route.

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const server = createBackendMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP request error:', e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless mode has no server-initiated stream or session to tear down.
router.get('/', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});
router.delete('/', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

export default router;
