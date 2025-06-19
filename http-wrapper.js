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
app.use(cors());
app.use(express.json());

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

    res.on('close', () => {
      this.sseClients.delete(res);
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
app.get('/mcp/v1/sse', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Get or create session
  let sessionId = req.headers['mcp-session-id'] || uuidv4();
  let session = sessions.get(sessionId);
  
  if (!session) {
    session = new MCPSession(sessionId);
    sessions.set(sessionId, session);
  }

  // Add this client to the session
  session.addSSEClient(res);

  // Send session ID in the first message
  res.write(`data: ${JSON.stringify({
    type: 'session',
    sessionId: sessionId
  })}\n\n`);

  req.on('close', () => {
    session.sseClients.delete(res);
  });
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
