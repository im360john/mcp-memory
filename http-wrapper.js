// http-wrapper.js - Optimized HTTP/SSE wrapper for MCP stdio server
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3333;

// Enable CORS and JSON parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization'],
  credentials: false
}));
app.use(express.json());

// Handle OPTIONS requests for CORS preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
  res.sendStatus(200);
});

// Pre-initialize a global MCP session for immediate responses
let globalMCPSession = null;
let isGlobalSessionReady = false;
const sseClients = new Set();

class OptimizedMCPSession {
  constructor() {
    this.process = null;
    this.initialized = false;
    this.requestCallbacks = new Map();
    this.messageId = 1;
    this.tools = [];
    this.lastActivity = Date.now();
    
    this.startMCPProcess();
  }

  startMCPProcess() {
    console.log('Starting global MCP process...');
    
    // Spawn the MCP server process
    this.process = spawn('node', [path.join(__dirname, 'src/server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    // Handle process stdout (MCP responses)
    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          this.handleMCPMessage(message);
        } catch (error) {
          console.error('Failed to parse MCP message:', error.message);
        }
      }
    });

    // Handle process stderr (logs)
    this.process.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const logMessage = JSON.parse(line);
          console.log('MCP log:', logMessage);
        } catch (error) {
          // Non-JSON stderr output
          console.log('MCP stderr:', line);
        }
      }
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      console.log(`MCP process exited with code ${code}`);
      this.initialized = false;
      isGlobalSessionReady = false;
      
      // Restart process after a delay
      setTimeout(() => {
        if (globalMCPSession === this) {
          this.startMCPProcess();
        }
      }, 5000);
    });

    // Initialize the MCP server
    this.initializeMCP();
  }

  async initializeMCP() {
    console.log('Initializing MCP session...');
    
    const initMessage = {
      jsonrpc: "2.0",
      id: this.getNextMessageId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        clientInfo: {
          name: "HTTP-SSE-Bridge",
          version: "1.0.0"
        }
      }
    };

    try {
      const result = await this.sendMCPMessage(initMessage);
      console.log('MCP initialization successful:', result);
      
      // Send initialized notification
      this.sendToMCP({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      this.initialized = true;
      
      // Pre-load tools list for fast responses
      await this.loadTools();
      
      isGlobalSessionReady = true;
      console.log('Global MCP session ready with tools:', this.tools.map(t => t.name));
      
    } catch (error) {
      console.error('MCP initialization failed:', error.message);
      setTimeout(() => this.initializeMCP(), 2000);
    }
  }

  async loadTools() {
    try {
      const message = {
        jsonrpc: "2.0",
        id: this.getNextMessageId(),
        method: "tools/list"
      };
      
      const result = await this.sendMCPMessage(message);
      this.tools = result.tools || [];
      console.log('Loaded tools:', this.tools.length);
    } catch (error) {
      console.error('Failed to load tools:', error.message);
      this.tools = [];
    }
  }

  sendToMCP(message) {
    if (this.process && !this.process.killed) {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  sendMCPMessage(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requestCallbacks.delete(message.id);
        reject(new Error('Request timeout'));
      }, 5000);

      this.requestCallbacks.set(message.id, (response) => {
        clearTimeout(timeout);
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      });

      this.sendToMCP(message);
    });
  }

  handleMCPMessage(message) {
    this.lastActivity = Date.now();
    
    // Handle responses to our requests
    if (message.id && this.requestCallbacks.has(message.id)) {
      const callback = this.requestCallbacks.get(message.id);
      this.requestCallbacks.delete(message.id);
      callback(message);
      return;
    }

    // Handle notifications - broadcast to SSE clients
    this.broadcastToSSE({
      type: 'message',
      data: message
    });
  }

  broadcastToSSE(data) {
    const sseData = `data: ${JSON.stringify(data)}\n\n`;
    
    for (const client of sseClients) {
      try {
        client.write(sseData);
      } catch (error) {
        sseClients.delete(client);
      }
    }
  }

  async ping() {
    // Always respond immediately to ping
    return true; // Just return true, not an object
  }

  async listTools() {
    // Return tools directly, not wrapped in an object
    return this.tools || [];
  }

  async callTool(toolName, args) {
    if (!this.initialized) {
      throw new Error('MCP session not ready');
    }

    const message = {
      jsonrpc: "2.0",
      id: this.getNextMessageId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args
      }
    };

    return await this.sendMCPMessage(message);
  }

  getNextMessageId() {
    return this.messageId++;
  }

  cleanup() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

// Initialize global session immediately on startup
console.log('Initializing global MCP session...');
globalMCPSession = new OptimizedMCPSession();

// Health check endpoint
app.get('/mcp/v1/health', (req, res) => {
  res.json({
    status: 'success',
    data: {
      server: 'MCP Memory Server',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      sessionReady: isGlobalSessionReady,
      initialized: globalMCPSession?.initialized || false,
      toolsLoaded: globalMCPSession?.tools?.length || 0,
      processRunning: globalMCPSession?.process && !globalMCPSession.process.killed,
      sseClientsConnected: sseClients.size,
      lastActivity: globalMCPSession?.lastActivity ? new Date(globalMCPSession.lastActivity).toISOString() : null
    }
  });
});

// Debug endpoint to test ping directly
app.get('/mcp/v1/debug/ping', async (req, res) => {
  try {
    const result = await globalMCPSession.ping();
    res.json({
      status: 'success',
      method: 'ping',
      result: result,
      sessionReady: isGlobalSessionReady,
      responseTime: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Debug endpoint to test tools list
app.get('/mcp/v1/debug/tools', async (req, res) => {
  try {
    const result = await globalMCPSession.listTools();
    res.json({
      status: 'success',
      method: 'tools/list',
      result: result,
      sessionReady: isGlobalSessionReady,
      responseTime: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// SSE endpoint for real-time communication
app.get('/mcp/v1/sse', async (req, res) => {
  console.log('SSE connection from:', req.ip);
  
  // Set SSE headers immediately
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, mcp-session-id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });

  // Add to SSE clients
  sseClients.add(res);
  console.log('SSE clients connected:', sseClients.size);

  // Send initial connection event like the Snowflake server
  res.write(`event: open\n`);
  res.write(`data: ${JSON.stringify({
    protocol: "mcp",
    version: "1.0.0",
    capabilities: {
      tools: true
    }
  })}\n\n`);

  // Send ready status if initialized
  if (isGlobalSessionReady) {
    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({
      type: "ready",
      tools: globalMCPSession?.tools?.length || 0
    })}\n\n`);
  }

  // Heartbeat every 30 seconds like the Snowflake server
  const heartbeat = setInterval(() => {
    if (sseClients.has(res)) {
      try {
        res.write(`event: ping\n`);
        res.write(`data: ${JSON.stringify({
          type: "ping"
        })}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log('SSE client disconnected. Remaining:', sseClients.size);
  });

  req.on('error', (error) => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.error('SSE connection error:', error.message);
  });
});

// Handle MCP JSON-RPC messages via POST
app.post('/mcp/v1/sse', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('MCP message received:', req.body.method, 'id:', req.body.id);
    
    const { jsonrpc, id, method, params } = req.body;
    
    if (jsonrpc !== "2.0") {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: "Invalid Request: jsonrpc version must be 2.0"
        }
      });
    }

    let result;

    // Handle methods with immediate responses
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {
              listChanged: false
            },
            resources: {
              listChanged: false,
              subscribe: false
            },
            prompts: {
              listChanged: false
            }
          },
          serverInfo: {
            name: "memory",
            version: "1.0.0"
          }
        };
        console.log(`Initialize responded in ${Date.now() - startTime}ms`);
        break;

      case 'ping':
        // Respond immediately for ping - no need to wait for MCP process
        console.log(`Ping responded in ${Date.now() - startTime}ms`);
        return res.json({
          jsonrpc: "2.0",
          id
          // Ping responses don't need a result field, just the acknowledgment
        });
      
      case 'tools/list':
        // Return cached tools immediately
        result = {
          tools: globalMCPSession?.tools || [
            {
              name: "memory.create",
              description: "Create a new memory entry",
              inputSchema: {
                type: "object",
                required: ["type", "content", "source", "confidence"],
                properties: {
                  type: { type: "string", description: "Type of memory" },
                  content: { type: "object", description: "Content to store" },
                  source: { type: "string", description: "Source of the memory" },
                  tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
                  confidence: { type: "number", description: "Confidence score between 0 and 1" }
                }
              }
            },
            {
              name: "memory.search",
              description: "Search for memories using semantic similarity",
              inputSchema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string", description: "Search query" },
                  type: { type: "string", description: "Optional type filter" },
                  tags: { type: "array", items: { type: "string" }, description: "Optional tags filter" },
                  limit: { type: "number", description: "Maximum number of results to return" }
                }
              }
            },
            {
              name: "memory.list",
              description: "List all memories",
              inputSchema: {
                type: "object",
                properties: {
                  type: { type: "string", description: "Optional type filter" },
                  tags: { type: "array", items: { type: "string" }, description: "Optional tags filter" }
                }
              }
            }
          ]
        };
        console.log(`Tools list responded in ${Date.now() - startTime}ms with ${result.tools.length} tools`);
        break;
        
      case 'tools/call':
        if (!isGlobalSessionReady) {
          throw new Error('MCP session not ready');
        }
        
        const toolResult = await globalMCPSession.callTool(params.name, params.arguments || params.input || {});
        
        // Format response like the Snowflake server
        result = {
          content: [
            {
              type: "text", 
              text: JSON.stringify(toolResult)
            }
          ]
        };
        console.log(`Tool call ${params.name} responded in ${Date.now() - startTime}ms`);
        break;

      case 'notifications/initialized':
        // This is a notification, no response needed
        console.log('Received initialized notification');
        return res.status(204).send(); // No content response
        
      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    // Send successful JSON-RPC response
    const response = {
      jsonrpc: "2.0",
      id,
      result
    };
    
    res.json(response);

  } catch (error) {
    console.error(`Error handling ${req.body.method}:`, error.message);
    
    const errorResponse = {
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32000,
        message: error.message
      }
    };
    
    res.json(errorResponse);
  }
});

// Legacy REST endpoints for backward compatibility
app.post('/mcp/v1/memory', async (req, res) => {
  try {
    if (!isGlobalSessionReady) {
      throw new Error('MCP session not ready');
    }
    
    const result = await globalMCPSession.callTool('memory.create', req.body);
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error creating memory:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.get('/mcp/v1/memory/search', async (req, res) => {
  try {
    if (!isGlobalSessionReady) {
      throw new Error('MCP session not ready');
    }
    
    const { query, type, tags, limit } = req.query;
    const searchArgs = { query };
    
    if (type) searchArgs.type = type;
    if (tags) searchArgs.tags = tags.split(',');
    if (limit) searchArgs.limit = parseInt(limit);

    const result = await globalMCPSession.callTool('memory.search', searchArgs);
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error searching memories:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.get('/mcp/v1/memory', async (req, res) => {
  try {
    if (!isGlobalSessionReady) {
      throw new Error('MCP session not ready');
    }
    
    const { type, tags } = req.query;
    const listArgs = {};
    
    if (type) listArgs.type = type;
    if (tags) listArgs.tags = tags.split(',');

    const result = await globalMCPSession.callTool('memory.list', listArgs);
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error listing memories:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Tools endpoint
app.get('/mcp/v1/tools', async (req, res) => {
  try {
    const result = await globalMCPSession.listTools();
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error listing tools:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Keep global session alive
setInterval(() => {
  if (globalMCPSession && isGlobalSessionReady) {
    // Send a ping to keep the session active
    globalMCPSession.ping().catch(() => {
      console.log('Session ping failed, may need restart');
    });
  }
}, 60000);

// Start the HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-SSE Bridge server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/mcp/v1/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/mcp/v1/sse`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  
  if (globalMCPSession) {
    globalMCPSession.cleanup();
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
  if (globalMCPSession) {
    globalMCPSession.cleanup();
  }
  
  process.exit(0);
});
