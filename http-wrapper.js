// http-wrapper.js - HTTP/SSE wrapper for the MCP stdio server
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

// Store active MCP sessions
const sessions = new Map();

class MCPSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.process = null;
    this.initialized = false;
    this.messageQueue = [];
    this.sseClients = new Set();
    this.requestCallbacks = new Map();
    this.messageId = 1;
    
    this.startMCPProcess();
  }

  startMCPProcess() {
    console.log(`Starting MCP process for session ${this.sessionId}`);
    
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
          // Forward logs to SSE clients
          this.broadcastToSSE({
            type: 'log',
            data: logMessage
          });
        } catch (error) {
          // Non-JSON stderr output, just log it
          console.log('MCP stderr:', line);
        }
      }
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      console.log(`MCP process exited with code ${code} for session ${this.sessionId}`);
      this.cleanup();
    });

    // Initialize the MCP server
    this.initializeMCP();
  }

  async initializeMCP() {
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

    return new Promise((resolve, reject) => {
      this.requestCallbacks.set(initMessage.id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          this.initialized = true;
          
          // Send initialized notification
          this.sendToMCP({
            jsonrpc: "2.0",
            method: "initialized"
          });
          
          resolve(response.result);
        }
      });

      this.sendToMCP(initMessage);
    });
  }

  sendToMCP(message) {
    if (this.process && !this.process.killed) {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  handleMCPMessage(message) {
    // Handle responses to our requests
    if (message.id && this.requestCallbacks.has(message.id)) {
      const callback = this.requestCallbacks.get(message.id);
      this.requestCallbacks.delete(message.id);
      callback(message);
      return;
    }

    // Handle notifications and other messages
    this.broadcastToSSE({
      type: 'message',
      data: message
    });
  }

  broadcastToSSE(data) {
    const sseData = `data: ${JSON.stringify(data)}\n\n`;
    
    for (const client of this.sseClients) {
      try {
        client.write(sseData);
      } catch (error) {
        // Remove disconnected clients
        this.sseClients.delete(client);
      }
    }
  }

  addSSEClient(res) {
    this.sseClients.add(res);
    
    // Send connection established message
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      sessionId: this.sessionId,
      initialized: this.initialized
    })}\n\n`);

    // Send heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      if (this.sseClients.has(res)) {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'heartbeat',
            timestamp: new Date().toISOString()
          })}\n\n`);
        } catch (error) {
          clearInterval(heartbeat);
          this.sseClients.delete(res);
        }
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
      console.log(`SSE client disconnected from session ${this.sessionId}`);
    });

    res.on('error', (error) => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
      console.error(`SSE client error in session ${this.sessionId}:`, error.message);
    });
  }

  async callTool(toolName, args) {
    if (!this.initialized) {
      throw new Error('MCP session not initialized');
    }

    const messageId = this.getNextMessageId();
    const message = {
      jsonrpc: "2.0",
      id: messageId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args
      }
    };

    return new Promise((resolve, reject) => {
      this.requestCallbacks.set(messageId, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      });

      this.sendToMCP(message);
    });
  }

  async listTools() {
    if (!this.initialized) {
      throw new Error('MCP session not initialized');
    }

    const messageId = this.getNextMessageId();
    const message = {
      jsonrpc: "2.0",
      id: messageId,
      method: "tools/list"
    };

    return new Promise((resolve, reject) => {
      this.requestCallbacks.set(messageId, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      });

      this.sendToMCP(message);
    });
  }

  async ping() {
    // For ping, we can respond immediately without going to the MCP server
    // since the HTTP wrapper itself is the connection indicator
    return { pong: true };
  }

  async sendMCPMessage(method, params = {}) {
    if (!this.initialized && method !== 'ping') {
      throw new Error('MCP session not initialized');
    }

    // Handle ping locally
    if (method === 'ping') {
      return { pong: true };
    }

    const messageId = this.getNextMessageId();
    const message = {
      jsonrpc: "2.0",
      id: messageId,
      method: method,
      params: params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requestCallbacks.delete(messageId);
        reject(new Error('Request timeout'));
      }, 10000); // 10 second timeout

      this.requestCallbacks.set(messageId, (response) => {
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

  getNextMessageId() {
    return this.messageId++;
  }

  cleanup() {
    // Close all SSE connections
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch (error) {
        // Ignore errors when closing
      }
    }
    this.sseClients.clear();

    // Clean up process
    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    // Remove from sessions map
    sessions.delete(this.sessionId);
  }
}

// Health check endpoint
app.get('/mcp/v1/health', (req, res) => {
  res.json({
    status: 'success',
    data: {
      server: 'MCP Memory Server',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      activeSessions: sessions.size
    }
  });
});

// SSE endpoint for real-time communication
app.get('/mcp/v1/sse', async (req, res) => {
  console.log('SSE connection attempt from:', req.ip);
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, mcp-session-id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });

  // Get or create session
  let sessionId = req.headers['mcp-session-id'] || uuidv4();
  console.log(`SSE session: ${sessionId}`);
  
  let session = sessions.get(sessionId);
  
  if (!session) {
    console.log(`Creating new MCP session: ${sessionId}`);
    session = new MCPSession(sessionId);
    sessions.set(sessionId, session);
    
    // Wait for MCP initialization
    try {
      await new Promise((resolve, reject) => {
        const checkInit = () => {
          if (session.initialized) {
            resolve();
          } else if (session.process?.killed) {
            reject(new Error('MCP process died'));
          } else {
            setTimeout(checkInit, 100);
          }
        };
        checkInit();
        
        // Timeout after 10 seconds
        setTimeout(() => reject(new Error('Initialization timeout')), 10000);
      });
    } catch (error) {
      console.error(`Failed to initialize MCP session ${sessionId}:`, error.message);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: error.message
      })}\n\n`);
      res.end();
      return;
    }
  }

  // Add this client to the session
  session.addSSEClient(res);

  // Send session ID and ready status
  res.write(`data: ${JSON.stringify({
    type: 'session',
    sessionId: sessionId,
    initialized: session.initialized
  })}\n\n`);

  // Send ready event
  res.write(`data: ${JSON.stringify({
    type: 'ready'
  })}\n\n`);

  req.on('close', () => {
    console.log(`SSE client disconnected from session ${sessionId}`);
    session.sseClients.delete(res);
  });

  req.on('error', (error) => {
    console.error(`SSE connection error for session ${sessionId}:`, error.message);
    session.sseClients.delete(res);
  });
});

// Handle MCP JSON-RPC messages via POST
app.post('/mcp/v1/sse', async (req, res) => {
  try {
    console.log('Received MCP message:', req.body);
    
    const { jsonrpc, id, method, params } = req.body;
    
    if (jsonrpc !== "2.0") {
      return res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: "Invalid Request: jsonrpc version must be 2.0"
        }
      });
    }

    // Get session
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      
      // Wait for initialization
      await new Promise((resolve, reject) => {
        const checkInit = () => {
          if (session.initialized) {
            resolve();
          } else if (session.process?.killed) {
            reject(new Error('MCP process died'));
          } else {
            setTimeout(checkInit, 100);
          }
        };
        checkInit();
        
        // Timeout after 5 seconds
        setTimeout(() => reject(new Error('Initialization timeout')), 5000);
      });
    }

    let result;

    // Handle different methods
    switch (method) {
      case 'ping':
        result = await session.ping();
        break;
      
      case 'tools/list':
        result = await session.listTools();
        break;
        
      case 'tools/call':
        result = await session.callTool(params.name, params.arguments || params.input || {});
        break;
        
      default:
        // Forward other methods to the MCP server
        result = await session.sendMCPMessage(method, params);
        break;
    }

    // Send JSON-RPC response
    res.json({
      jsonrpc: "2.0",
      id,
      result
    });

  } catch (error) {
    console.error('Error handling MCP message:', error);
    
    const errorResponse = {
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: -32000,
        message: error.message
      }
    };
    
    res.status(500).json(errorResponse);
  }
});

// Memory operations endpoints
app.post('/mcp/v1/memory', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const result = await session.callTool('memory.create', req.body);
    
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
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const { query, type, tags, limit } = req.query;
    const searchArgs = { query };
    
    if (type) searchArgs.type = type;
    if (tags) searchArgs.tags = tags.split(',');
    if (limit) searchArgs.limit = parseInt(limit);

    const result = await session.callTool('memory.search', searchArgs);
    
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
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const { type, tags } = req.query;
    const listArgs = {};
    
    if (type) listArgs.type = type;
    if (tags) listArgs.tags = tags.split(',');

    const result = await session.callTool('memory.list', listArgs);
    
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
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const result = await session.listTools();
    
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

// Generic tool call endpoint
app.post('/mcp/v1/tools/:toolName', async (req, res) => {
  try {
    const { toolName } = req.params;
    const sessionId = req.headers['mcp-session-id'] || 'default';
    let session = sessions.get(sessionId);
    
    if (!session) {
      session = new MCPSession(sessionId);
      sessions.set(sessionId, session);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const result = await session.callTool(toolName, req.body);
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error(`Error calling tool ${req.params.toolName}:`, error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Cleanup sessions periodically
setInterval(() => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.sseClients.size === 0 && !session.process?.killed) {
      console.log(`Cleaning up inactive session: ${sessionId}`);
      session.cleanup();
    }
  }
}, 60000); // Check every minute

// Start the HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-SSE Bridge server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/mcp/v1/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/mcp/v1/sse`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  
  // Cleanup all sessions
  for (const session of sessions.values()) {
    session.cleanup();
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
  // Cleanup all sessions
  for (const session of sessions.values()) {
    session.cleanup();
  }
  
  process.exit(0);
});
