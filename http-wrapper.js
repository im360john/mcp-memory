// http-wrapper.js - Fixed HTTP/SSE wrapper for MCP stdio server
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// LOGGING FUNCTIONS - MUST BE FIRST
function debugLog(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

function errorLog(message, error = null) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [ERROR] ${message}`, error ? error.stack || error.message || error : '');
}

function infoLog(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3333;

infoLog('HTTP Wrapper starting up', {
  nodeVersion: process.version,
  platform: process.platform,
  port: PORT,
  workingDir: process.cwd()
});

// Enable CORS and JSON parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization'],
  credentials: false
}));

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  debugLog(`Incoming request: ${req.method} ${req.path}`, {
    headers: req.headers,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    infoLog(`Request completed: ${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`
    });
  });
  
  next();
});

app.use(express.json());

// Handle OPTIONS requests for CORS preflight
app.options('*', (req, res) => {
  debugLog('CORS preflight request');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
  res.sendStatus(200);
});

// Global session state
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
    this.initializationStarted = false;
    
    infoLog('Creating new MCP session');
    this.startMCPProcess();
  }

  startMCPProcess() {
    infoLog('Starting MCP process...', {
      serverPath: path.join(__dirname, 'src/server.js'),
      cwd: process.cwd()
    });
    
    try {
      this.process = spawn('node', [path.join(__dirname, 'src/server.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: process.cwd()
      });

      infoLog('MCP process spawned', {
        pid: this.process.pid,
        hasStdin: !!this.process.stdin,
        hasStdout: !!this.process.stdout,
        hasStderr: !!this.process.stderr
      });

      this.process.stdout.on('data', (data) => {
        const dataStr = data.toString();
        debugLog('MCP stdout received', { length: dataStr.length });
        
        const lines = dataStr.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            debugLog('Parsed MCP message', message);
            this.handleMCPMessage(message);
          } catch (error) {
            debugLog('Failed to parse MCP stdout as JSON', { line, error: error.message });
          }
        }
      });

      this.process.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const logMessage = JSON.parse(line);
            debugLog('MCP log message', logMessage);
          } catch (error) {
            infoLog('MCP stderr (non-JSON)', { line });
          }
        }
      });

      this.process.on('exit', (code, signal) => {
        errorLog('MCP process exited', { code, signal, pid: this.process.pid });
        this.initialized = false;
        isGlobalSessionReady = false;
        
        setTimeout(() => {
          if (globalMCPSession === this) {
            infoLog('Restarting MCP process after exit');
            this.startMCPProcess();
          }
        }, 5000);
      });

      this.process.on('error', (error) => {
        errorLog('MCP process error', error);
      });

      setTimeout(() => {
        this.initializeMCP();
      }, 1000);

    } catch (error) {
      errorLog('Failed to spawn MCP process', error);
    }
  }

  async initializeMCP() {
    if (this.initializationStarted) {
      debugLog('MCP initialization already in progress');
      return;
    }
    
    this.initializationStarted = true;
    infoLog('Starting MCP initialization...');
    
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

    debugLog('Sending initialization message', initMessage);

    try {
      const result = await this.sendMCPMessage(initMessage);
      infoLog('MCP initialization successful', result);
      
      const notificationMessage = {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      };
      
      debugLog('Sending initialized notification', notificationMessage);
      this.sendToMCP(notificationMessage);

      this.initialized = true;
      
      await this.loadTools();
      
      isGlobalSessionReady = true;
      infoLog('Global MCP session ready', {
        toolsLoaded: this.tools.length,
        toolNames: this.tools.map(t => t.name)
      });
      
    } catch (error) {
      errorLog('MCP initialization failed', error);
      this.initializationStarted = false;
      setTimeout(() => this.initializeMCP(), 2000);
    }
  }

  async loadTools() {
    infoLog('Loading tools from MCP server...');
    
    try {
      const message = {
        jsonrpc: "2.0",
        id: this.getNextMessageId(),
        method: "tools/list"
      };
      
      debugLog('Sending tools/list request', message);
      const result = await this.sendMCPMessage(message);
      
      this.tools = result.tools || [];
      infoLog('Tools loaded successfully', {
        count: this.tools.length,
        tools: this.tools.map(t => ({ name: t.name, description: t.description }))
      });
    } catch (error) {
      errorLog('Failed to load tools', error);
      this.tools = [];
    }
  }

  sendToMCP(message) {
    debugLog('Sending message to MCP process', message);
    
    if (!this.process || this.process.killed) {
      errorLog('Cannot send to MCP: process not available', {
        hasProcess: !!this.process,
        killed: this.process?.killed
      });
      return;
    }

    try {
      const messageStr = JSON.stringify(message) + '\n';
      this.process.stdin.write(messageStr);
      debugLog('Message sent to MCP stdin successfully');
    } catch (error) {
      errorLog('Failed to write to MCP stdin', error);
    }
  }

  sendMCPMessage(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requestCallbacks.delete(message.id);
        errorLog('MCP request timeout', { messageId: message.id, method: message.method });
        reject(new Error('Request timeout'));
      }, 10000);

      this.requestCallbacks.set(message.id, (response) => {
        clearTimeout(timeout);
        debugLog('Received MCP response', { messageId: message.id, response });
        
        if (response.error) {
          errorLog('MCP returned error', response.error);
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
    debugLog('Handling MCP message', message);
    
    if (message.id && this.requestCallbacks.has(message.id)) {
      const callback = this.requestCallbacks.get(message.id);
      this.requestCallbacks.delete(message.id);
      debugLog('Found callback for message ID', { messageId: message.id });
      callback(message);
      return;
    }

    debugLog('Broadcasting message to SSE clients', { clientCount: sseClients.size });
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
        debugLog('Failed to write to SSE client, removing', { error: error.message });
        sseClients.delete(client);
      }
    }
  }

  async ping() {
    debugLog('Ping method called');
    return true;
  }

  async listTools() {
    debugLog('ListTools method called', { toolCount: this.tools.length });
    return this.tools || [];
  }

  async callTool(toolName, args) {
    infoLog('Tool call requested', { toolName, args });
    
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
    infoLog('Cleaning up MCP session');
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

// Health check endpoint
app.get('/mcp/v1/health', (req, res) => {
  debugLog('Health check requested');
  
  const healthData = {
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
      lastActivity: globalMCPSession?.lastActivity ? new Date(globalMCPSession.lastActivity).toISOString() : null,
      processPid: globalMCPSession?.process?.pid || null,
      initializationStarted: globalMCPSession?.initializationStarted || false
    }
  };
  
  infoLog('Health check response', healthData);
  res.json(healthData);
});

// SSE endpoint for real-time communication
app.get('/mcp/v1/sse', async (req, res) => {
  infoLog('SSE connection attempt', {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control, mcp-session-id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });

    sseClients.add(res);
    infoLog('SSE client added', { totalClients: sseClients.size });

    // Send initial connection event exactly like Snowflake server
    const openEvent = {
      protocol: "mcp",
      version: "1.0.0",
      capabilities: {
        tools: true
      }
    };
    
    res.write(`event: open\n`);
    res.write(`data: ${JSON.stringify(openEvent)}\n\n`);
    debugLog('Sent open event to SSE client', openEvent);

    // Send tools immediately to mimic working servers
    if (isGlobalSessionReady && globalMCPSession?.tools?.length > 0) {
      const toolsEvent = {
        tools: globalMCPSession.tools
      };
      
      res.write(`event: tools\n`);
      res.write(`data: ${JSON.stringify(toolsEvent)}\n\n`);
      debugLog('Sent tools event to SSE client', { toolCount: globalMCPSession.tools.length });
      
      // Also send capabilities
      const capabilitiesEvent = {
        tools: {
          listChanged: false
        }
      };
      
      res.write(`event: capabilities\n`);
      res.write(`data: ${JSON.stringify(capabilitiesEvent)}\n\n`);
      debugLog('Sent capabilities event to SSE client', capabilitiesEvent);
    } else {
      debugLog('Session not ready or no tools, skipping tools event');
    }

    const heartbeat = setInterval(() => {
      if (sseClients.has(res)) {
        try {
          const pingEvent = {
            type: "ping",
            timestamp: new Date().toISOString()
          };
          
          res.write(`event: ping\n`);
          res.write(`data: ${JSON.stringify(pingEvent)}\n\n`);
          debugLog('Sent heartbeat ping to SSE client');
        } catch (error) {
          errorLog('Failed to send heartbeat', error);
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
      infoLog('SSE client disconnected', { remainingClients: sseClients.size });
    });

    req.on('error', (error) => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      errorLog('SSE connection error', error);
    });

  } catch (error) {
    errorLog('SSE endpoint error', error);
    res.status(500).send('Internal Server Error');
  }
});

// SSE endpoint for real-time communication (GET only)
app.get('/mcp/v1/sse', async (req, res) => {
  infoLog('SSE connection attempt', {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control, mcp-session-id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });

    sseClients.add(res);
    infoLog('SSE client added', { totalClients: sseClients.size });

    // Send initial connection event exactly like Snowflake server
    const openEvent = {
      protocol: "mcp",
      version: "1.0.0",
      capabilities: {
        tools: true
      }
    };
    
    res.write(`event: open\n`);
    res.write(`data: ${JSON.stringify(openEvent)}\n\n`);
    debugLog('Sent open event to SSE client', openEvent);

    // Send tools immediately to mimic working servers
    if (isGlobalSessionReady && globalMCPSession?.tools?.length > 0) {
      const toolsEvent = {
        tools: globalMCPSession.tools
      };
      
      res.write(`event: tools\n`);
      res.write(`data: ${JSON.stringify(toolsEvent)}\n\n`);
      debugLog('Sent tools event to SSE client', { toolCount: globalMCPSession.tools.length });
      
      // Also send capabilities
      const capabilitiesEvent = {
        tools: {
          listChanged: false
        }
      };
      
      res.write(`event: capabilities\n`);
      res.write(`data: ${JSON.stringify(capabilitiesEvent)}\n\n`);
      debugLog('Sent capabilities event to SSE client', capabilitiesEvent);
    } else {
      debugLog('Session not ready or no tools, skipping tools event');
    }

    const heartbeat = setInterval(() => {
      if (sseClients.has(res)) {
        try {
          const pingEvent = {
            type: "ping",
            timestamp: new Date().toISOString()
          };
          
          res.write(`event: ping\n`);
          res.write(`data: ${JSON.stringify(pingEvent)}\n\n`);
          debugLog('Sent heartbeat ping to SSE client');
        } catch (error) {
          errorLog('Failed to send heartbeat', error);
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
      infoLog('SSE client disconnected', { remainingClients: sseClients.size });
    });

    req.on('error', (error) => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      errorLog('SSE connection error', error);
    });

  } catch (error) {
    errorLog('SSE endpoint error', error);
    res.status(500).send('Internal Server Error');
  }
});

// Separate messages endpoint for JSON-RPC (like Snowflake server)
app.post('/mcp/v1/messages', async (req, res) => {
  const startTime = Date.now();
  
  infoLog('MCP JSON-RPC message received via POST /mcp/v1/messages', {
    method: req.body?.method,
    id: req.body?.id,
    hasParams: !!req.body?.params,
    bodySize: JSON.stringify(req.body || {}).length
  });
  
  try {
    debugLog('Full request body', req.body);
    
    const { jsonrpc, id, method, params } = req.body;
    
    if (jsonrpc !== "2.0") {
      const errorResponse = {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: "Invalid Request: jsonrpc version must be 2.0"
        }
      };
      
      errorLog('Invalid JSON-RPC version', { received: jsonrpc, expected: "2.0" });
      return res.json(errorResponse);
    }

    let result;

    switch (method) {
      case 'initialize':
        debugLog('Handling initialize request', params);
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
        infoLog(`Initialize handled in ${Date.now() - startTime}ms`);
        break;

      case 'ping':
        debugLog('Handling ping request');
        infoLog(`Ping handled in ${Date.now() - startTime}ms`);
        return res.json({
          jsonrpc: "2.0",
          id
        });
      
      case 'tools/list':
        debugLog('Handling tools/list request', {
          sessionReady: isGlobalSessionReady,
          toolsAvailable: globalMCPSession?.tools?.length || 0
        });
        
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
        infoLog(`Tools list handled in ${Date.now() - startTime}ms`, {
          toolCount: result.tools.length
        });
        break;
        
      case 'tools/call':
        debugLog('Handling tools/call request', {
          toolName: params?.name,
          sessionReady: isGlobalSessionReady,
          hasArguments: !!params?.arguments
        });
        
        if (!isGlobalSessionReady) {
          throw new Error('MCP session not ready');
        }
        
        const toolResult = await globalMCPSession.callTool(params.name, params.arguments || params.input || {});
        
        result = {
          content: [
            {
              type: "text", 
              text: JSON.stringify(toolResult)
            }
          ]
        };
        infoLog(`Tool call ${params.name} handled in ${Date.now() - startTime}ms`);
        break;

      case 'notifications/initialized':
        debugLog('Handling notifications/initialized');
        infoLog('Received initialized notification');
        return res.status(204).send();
        
      default:
        errorLog('Unsupported method', { method });
        throw new Error(`Unsupported method: ${method}`);
    }

    const response = {
      jsonrpc: "2.0",
      id,
      result
    };
    
    debugLog('Sending JSON-RPC response', response);
    res.json(response);

  } catch (error) {
    errorLog(`Error handling MCP method ${req.body?.method}`, error);
    
    const errorResponse = {
      jsonrpc: "2.0",
      id: req.body?.id || null,
      error: {
        code: -32000,
        message: error.message
      }
    };
    
    res.json(errorResponse);
  }
});

// Keep the original POST endpoint for backward compatibility
app.post('/mcp/v1/sse', async (req, res) => {
  infoLog('MCP JSON-RPC message received via POST /mcp/v1/sse (redirecting to /messages)', {
    method: req.body?.method,
    id: req.body?.id
  });
  
  // Forward to the messages handler
  req.url = '/mcp/v1/messages';
  return app._router.handle(req, res);
});

// Alternative endpoints that LibreChat might be trying
app.post('/mcp', async (req, res) => {
  infoLog('MCP JSON-RPC message received via POST /mcp', {
    method: req.body?.method,
    id: req.body?.id
  });
  
  req.url = '/mcp/v1/messages';
  return app._router.handle(req, res);
});

app.post('/sse', async (req, res) => {
  infoLog('MCP JSON-RPC message received via POST /sse', {
    method: req.body?.method,
    id: req.body?.id
  });
  
  req.url = '/mcp/v1/messages';
  return app._router.handle(req, res);
});

app.post('/messages', async (req, res) => {
  infoLog('MCP JSON-RPC message received via POST /messages', {
    method: req.body?.method,
    id: req.body?.id
  });
  
  req.url = '/mcp/v1/messages';
  return app._router.handle(req, res);
});

// Debug endpoint to test what URLs LibreChat might be trying
app.all('*', (req, res, next) => {
  // Only log unhandled routes
  if (!req.route) {
    infoLog('Unhandled route attempted', {
      method: req.method,
      path: req.path,
      url: req.url,
      headers: req.headers,
      body: req.body
    });
  }
  next();
});

// Start the HTTP server
app.listen(PORT, '0.0.0.0', () => {
  infoLog('HTTP-SSE Bridge server running', {
    port: PORT,
    healthCheck: `http://localhost:${PORT}/mcp/v1/health`,
    sseEndpoint: `http://localhost:${PORT}/mcp/v1/sse`,
    messagesEndpoint: `http://localhost:${PORT}/mcp/v1/messages`
  });
});

// Initialize global session immediately on startup
infoLog('Initializing global MCP session...');
globalMCPSession = new OptimizedMCPSession();

// Graceful shutdown
process.on('SIGTERM', () => {
  infoLog('Received SIGTERM, shutting down gracefully...');
  
  if (globalMCPSession) {
    globalMCPSession.cleanup();
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  infoLog('Received SIGINT, shutting down gracefully...');
  
  if (globalMCPSession) {
    globalMCPSession.cleanup();
  }
  
  process.exit(0);
});
