import pg from 'pg';
import { pipeline } from '@xenova/transformers';
import { promises as fs } from 'fs';
import fs_sync from 'fs';  // Added for sync file operations
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import dotenv from 'dotenv';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Debug log file path
const DEBUG_LOG_PATH = path.join(__dirname, '../memory-debug.log');

// Function to write debug logs to file
function debugLog(message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message} ${JSON.stringify(data, null, 2)}\n`;
  try {
    fs_sync.appendFileSync(DEBUG_LOG_PATH, logEntry);
  } catch (error) {
    console.error(`Failed to write to debug log: ${error.message}`);
  }
}

// Clear the log file on startup
try {
  fs_sync.writeFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] Memory server starting\n`);
  debugLog('Environment variables:', process.env);
} catch (error) {
  console.error(`Failed to initialize debug log: ${error.message}`);
}

// Initialize PostgreSQL connection pool
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  console.error("PostgreSQL connection pool initialized");
} catch (error) {
  console.error(`Failed to initialize PostgreSQL connection pool: ${error.message}`);
  process.exit(1);
}

// Setup stdio transport for local MCP
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Initialize BERT model for embeddings
let embedder;
let embedderInitializing = false;
let dbInitialized = false;

// Helper function for MCP logging
function sendLogMessage(level, message, context = {}) {
  const logMessage = {
    jsonrpc: "2.0",
    method: "log",
    params: {
      level,
      message,
      timestamp: new Date().toISOString(),
      context
    }
  };
  
  try {
    process.stderr.write(JSON.stringify(logMessage) + '\n');
  } catch (error) {
    process.stderr.write(`Error sending log message: ${error.message}\n`);
  }
}

// Lazy load embedder when needed
async function getEmbedder() {
  if (embedder) return embedder;
  
  if (!embedderInitializing) {
    embedderInitializing = true;
    try {
      sendLogMessage('info', 'Initializing embedder...');
      embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      sendLogMessage('info', 'Embedder initialized successfully');
    } catch (error) {
      sendLogMessage('error', `Error initializing embedder: ${error.message}`, { stack: error.stack });
      embedderInitializing = false;
      throw error;
    }
  } else {
    // Wait for initialization to complete
    sendLogMessage('info', 'Waiting for embedder initialization...');
    while (!embedder) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return embedder;
}

// Initialize database - but don't wait for it
async function initializeDatabase() {
  if (dbInitialized) return;
  
  try {
    const migrationSQL = await fs.readFile(path.join(__dirname, '../migrations/init.sql'), 'utf8');
    await pool.query(migrationSQL);
    dbInitialized = true;
    sendLogMessage('info', 'Database initialized successfully');
  } catch (error) {
    sendLogMessage('error', `Error initializing database: ${error.message}`, { stack: error.stack });
    // Don't exit on database error - we might be able to handle some requests
  }
}

// Start database initialization in the background
initializeDatabase().catch(err => {
  sendLogMessage('error', `Background database initialization failed: ${err.message}`);
});

// Helper function to prepare content for embedding
function prepareContentForEmbedding(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

// Helper function to generate embeddings
async function generateEmbedding(text) {
  try {
    const model = await getEmbedder();
    const output = await model(text, { pooling: 'mean', normalize: true });
    sendLogMessage('debug', 'Generated embedding', { textLength: text.length });
    return Array.from(output.data);
  } catch (error) {
    sendLogMessage('error', 'Failed to generate embedding', { error: error.message });
    throw error;
  }
}

// Track initialization states
let isInitialized = false;
let hasReceivedInitializedNotification = false;

// Initialize server
function initializeServer() {
  try {
    // Log startup immediately 
    debugLog('initializeServer() called', {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      workingDir: process.cwd(),
      env: {
        PORT: process.env.PORT,
        DATABASE_URL: process.env.DATABASE_URL,
        MCP_SERVER_NAME: process.env.MCP_SERVER_NAME,
        MCP_SERVER_VERSION: process.env.MCP_SERVER_VERSION
      }
    });
    
    sendLogMessage('info', 'MCP Memory Server starting up', {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform
    });
    
    // Set up stdio handling
    process.stdin.setEncoding('utf8');
    process.stdout.setDefaultEncoding('utf8');
    
    // Prevent Node from exiting on stdin end
    process.stdin.on('end', () => {
      sendLogMessage('info', 'stdin end received, keeping process alive');
    });
    
    // Handle stdin errors
    process.stdin.on('error', (error) => {
      sendLogMessage('error', 'stdin error', { error: error.message });
    });
    
    // Handle stdout errors
    process.stdout.on('error', (error) => {
      sendLogMessage('error', 'stdout error', { error: error.message });
    });
    
    // Keep process alive and indicate readiness
    setInterval(() => {
      if (!isInitialized) {
        sendLogMessage('debug', 'Waiting for initialization...', { pid: process.pid });
      }
    }, 30000);
    
    // Start background tasks if needed, but don't wait for them
    
    // Resume stdin after all handlers are set up
    process.stdin.resume();
    
    sendLogMessage('info', 'Server ready for initialization requests');
    return true;
  } catch (error) {
    sendLogMessage('error', 'Server initialization failed', { 
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// List resources implementation
async function handleListResources() {
  try {
    return [
      {
        name: "memory://types",
        description: "Lists all available memory types"
      },
      {
        name: "memory://tags",
        description: "Lists all available memory tags"
      }
    ];
  } catch (error) {
    sendLogMessage('error', 'Error in listResources', { error: error.message });
    throw error;
  }
}

// Read resource implementation
async function handleReadResource(resourceName) {
  try {
    // Ensure database is initialized before reading resources
    if (!dbInitialized) {
      await initializeDatabase();
    }

    if (resourceName === "memory://types") {
      const result = await pool.query("SELECT DISTINCT type FROM memories");
      const types = result.rows.map(row => row.type);
      return { content: JSON.stringify(types), mimeType: "application/json" };
    } else if (resourceName === "memory://tags") {
      const result = await pool.query("SELECT DISTINCT unnest(tags) as tag FROM memories");
      const tags = result.rows.map(row => row.tag);
      return { content: JSON.stringify(tags), mimeType: "application/json" };
    } else if (resourceName.startsWith("memory://type/")) {
      const type = resourceName.substring("memory://type/".length);
      const result = await pool.query("SELECT * FROM memories WHERE type = $1", [type]);
      return { content: JSON.stringify(result.rows), mimeType: "application/json" };
    } else {
      throw new Error(`Unknown resource: ${resourceName}`);
    }
  } catch (error) {
    sendLogMessage('error', `Error reading resource ${resourceName}`, { error: error.message });
    throw error;
  }
}

// Handle readline events
rl.on('close', () => {
  sendLogMessage('info', 'readline interface closed, keeping process alive');
});

// Initialize server first - this is now synchronous
initializeServer();

// Handle incoming JSON-RPC messages via stdio
rl.on('line', async (line) => {
  try {
    // Debug log for received message
    sendLogMessage('debug', 'Received message', { length: line.length });
    debugLog('Received raw message', { message: line });
    
    let message;
    try {
      message = JSON.parse(line);
      debugLog('Parsed message', message);
    } catch (error) {
      sendLogMessage('error', 'Failed to parse JSON', { error: error.message, line });
      debugLog('Failed to parse JSON', { error: error.message, line });
      // Don't respond to parse errors - it could confuse clients
      return;
    }
    
    const { jsonrpc, id, method, params = {} } = message;

    // No response for messages without ID - they are notifications
    if (id === undefined || id === null) {
      if (method === 'initialized' || method === 'notifications/initialized') {
        sendLogMessage('info', 'Received initialized notification');
        debugLog('Received initialized notification', { method });
        hasReceivedInitializedNotification = true;
      } else {
        sendLogMessage('info', `Received notification: ${method}`);
        debugLog('Received notification', { method });
      }
      return;
    }

    if (jsonrpc !== "2.0") {
      const error = {
        code: -32600,
        message: "Invalid Request: jsonrpc version must be 2.0"
      };
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id, // Use the exact same ID from the request
        error
      }) + '\n');
      return;
    }

    // Special handling for initialization sequence
    if (method === 'initialize') {
      debugLog('Received initialize request', { params, id });
      
      if (isInitialized) {
        debugLog('Server already initialized, rejecting request', { id });
        const error = {
          code: -32002,
          message: "Server already initialized"
        };
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error
        }) + '\n');
        return;
      }

      // Log client capabilities for debugging
      sendLogMessage('info', 'Processing initialize request', {
        clientInfo: params.clientInfo,
        clientCapabilities: params.capabilities,
        clientProtocolVersion: params.protocolVersion
      });

      // Log the protocol version
      debugLog("Client protocol version", { version: params.protocolVersion });
      
      // Accept any protocol version for now
      // Cursor is using a date-based version scheme "2024-11-05" rather than the expected "1.x.x"

      // Log environment variables for debugging
      debugLog("Environment variables for initialization", {
        MCP_SERVER_NAME: process.env.MCP_SERVER_NAME,
        MCP_SERVER_VERSION: process.env.MCP_SERVER_VERSION,
        NODE_ENV: process.env.NODE_ENV
      });

      // Server info and capabilities
      const serverInfo = {
        name: "memory",
        version: "1.0.0", 
        displayName: "Memory Server",
        description: "A server for storing and retrieving memories with semantic search capabilities",
        publisher: "MCP"
      };
      
      // Log server info for debugging
      debugLog("Responding with server info", serverInfo);

      // Respond with server capabilities
      const response = {
        jsonrpc: "2.0",
        id, // Use the exact ID from the request
        result: {
          serverInfo: serverInfo,
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
            },
            logging: {
              levels: ["error", "warn", "info", "debug"]
            }
          },
          protocolVersion: "2024-11-05"
        }
      };

      // Log the complete response for debugging
      debugLog("Sending complete initialization response", response);
      
      // Send initialization response
      process.stdout.write(JSON.stringify(response) + '\n');
      isInitialized = true;
      sendLogMessage('info', 'Server initialized successfully');
      return;
    }

    // All other messages require initialization
    if (!isInitialized) {
      const error = {
        code: -32002,
        message: "Server not initialized"
      };
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id, // Use the exact ID from the request
        error
      }) + '\n');
      return;
    }

    // Handle standard MCP method requests
    debugLog('Processing method', { method, id });
    
    switch (method) {
      case 'listTools':
      case 'tools/list':
        // Return all available tools
        debugLog('Processing tools list request', { id });
        const tools = [
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
        ];
        // Format response according to MCP 2.0 protocol
        const toolsResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools
          }
        };
        
        debugLog('Sending tools response', toolsResponse);
        process.stdout.write(JSON.stringify(toolsResponse) + '\n');
        break;

      case 'callTool':
      case 'tools/call':
        debugLog('Processing tool call', { method, id, params });
        // In the new protocol, arguments might be in params.input instead of params.arguments
        const toolName = params.name;
        const toolArgs = params.arguments || params.input || {};
        
        debugLog('Tool call details', { toolName, toolArgs });
        
        const name = toolName;

        switch (name) {
          case 'memory.create':
            try {
              // Ensure database is initialized before creating memories
              if (!dbInitialized) {
                await initializeDatabase();
              }
              
              sendLogMessage('info', 'Creating new memory', { type: toolArgs.type });
              const { type, content, source, tags = [], confidence } = toolArgs;
              const textForEmbedding = prepareContentForEmbedding(content);
              const embedding = await generateEmbedding(textForEmbedding);

              const query = `
                INSERT INTO memories (type, content, source, embedding, tags, confidence)
                VALUES ($1, $2::jsonb, $3, $4::vector, $5, $6)
                RETURNING *
              `;

              const dbResult = await pool.query(query, [
                type,
                JSON.stringify(content),
                source,
                `[${embedding.join(',')}]`,
                tags,
                confidence
              ]);

              sendLogMessage('info', 'Memory created successfully', { id: dbResult.rows[0].id });
              // Format response for tool call
              const createResponse = {
                jsonrpc: "2.0",
                id,
                result: {
                  tool: {
                    name: "memory.create",
                    output: dbResult.rows[0]
                  }
                }
              };
              
              debugLog('Sending memory create response', createResponse);
              process.stdout.write(JSON.stringify(createResponse) + '\n');
            } catch (error) {
              sendLogMessage('error', 'Failed to create memory', { error: error.message });
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: error.message
                }
              }) + '\n');
            }
            break;

          case 'memory.search':
            try {
              // Ensure database is initialized before searching memories
              if (!dbInitialized) {
                await initializeDatabase();
              }
              
              const { query, type, tags, limit = 10 } = toolArgs;
              sendLogMessage('info', 'Searching memories', { query, type, tags, limit });
              
              const embedding = await generateEmbedding(query);
              
              let sqlQuery = `
                SELECT *, 
                  1 - (embedding <=> $1::vector) as similarity
                FROM memories
                WHERE 1=1
              `;
              
              const queryParams = [`[${embedding.join(',')}]`];
              let paramCount = 1;

              if (type) {
                paramCount++;
                sqlQuery += ` AND type = $${paramCount}`;
                queryParams.push(type);
              }

              if (tags && tags.length > 0) {
                paramCount++;
                sqlQuery += ` AND tags && $${paramCount}`;
                queryParams.push(Array.isArray(tags) ? tags : tags.split(','));
              }

              sqlQuery += `
                ORDER BY similarity DESC
                LIMIT $${paramCount + 1}
              `;
              queryParams.push(parseInt(limit));

              const dbResult = await pool.query(sqlQuery, queryParams);
              sendLogMessage('info', 'Search completed', { resultCount: dbResult.rows.length });
              
              // Format response for search tool
              const searchResponse = {
                jsonrpc: "2.0",
                id,
                result: {
                  tool: {
                    name: "memory.search",
                    output: dbResult.rows
                  }
                }
              };
              
              debugLog('Sending memory search response', searchResponse);
              process.stdout.write(JSON.stringify(searchResponse) + '\n');
            } catch (error) {
              sendLogMessage('error', 'Search failed', { error: error.message });
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: error.message
                }
              }) + '\n');
            }
            break;

          case 'memory.list':
            try {
              // Ensure database is initialized before listing memories
              if (!dbInitialized) {
                await initializeDatabase();
              }
              
              const { type, tags } = toolArgs || {};
              
              let sqlQuery = 'SELECT * FROM memories WHERE 1=1';
              const queryParams = [];
              let paramCount = 0;

              if (type) {
                paramCount++;
                sqlQuery += ` AND type = $${paramCount}`;
                queryParams.push(type);
              }

              if (tags && tags.length > 0) {
                paramCount++;
                sqlQuery += ` AND tags && $${paramCount}`;
                queryParams.push(Array.isArray(tags) ? tags : tags.split(','));
              }

              sqlQuery += ' ORDER BY created_at DESC';

              const dbResult = await pool.query(sqlQuery, queryParams);
              
              // Format response for list tool
              const listResponse = {
                jsonrpc: "2.0",
                id,
                result: {
                  tool: {
                    name: "memory.list",
                    output: dbResult.rows
                  }
                }
              };
              
              debugLog('Sending memory list response', listResponse);
              process.stdout.write(JSON.stringify(listResponse) + '\n');
            } catch (error) {
              sendLogMessage('error', `Error in memory.list: ${error.message}`);
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: error.message
                }
              }) + '\n');
            }
            break;

          default:
            sendLogMessage('warn', 'Tool not found', { tool: name });
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32601,
                message: "Tool not found"
              }
            }) + '\n');
        }
        break;

      case 'listResources':
      case 'resources/list':
        try {
          debugLog('Processing resources list request', { id });
          const resources = await handleListResources();
          const resourcesResponse = {
            jsonrpc: "2.0",
            id,
            result: {
              resources: resources
            }
          };
          
          debugLog('Sending resources response', resourcesResponse);
          process.stdout.write(JSON.stringify(resourcesResponse) + '\n');
        } catch (error) {
          sendLogMessage('error', 'Error listing resources', { error: error.message });
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: error.message
            }
          }) + '\n');
        }
        break;

      case 'readResource':
      case 'resources/read':
        try {
          const { name: resourceName } = params;
          const { content, mimeType } = await handleReadResource(resourceName);
          const readResponse = {
            jsonrpc: "2.0",
            id,
            result: { 
              resource: {
                content, 
                mimeType
              }
            }
          };
          
          debugLog('Sending resource read response', readResponse);
          process.stdout.write(JSON.stringify(readResponse) + '\n');
        } catch (error) {
          sendLogMessage('error', 'Error reading resource', { error: error.message });
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: error.message
            }
          }) + '\n');
        }
        break;

      case 'listPrompts':
      case 'prompts/list':
        // Return empty list as we don't support prompts yet
        debugLog('Processing prompts list request', { id });
        const promptsResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: []
          }
        };
        
        debugLog('Sending prompts response', promptsResponse);
        process.stdout.write(JSON.stringify(promptsResponse) + '\n');
        break;

      default:
        sendLogMessage('warn', 'Method not found', { method });
        debugLog('Unhandled method', { method, id, params });
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        }) + '\n');
    }
  } catch (error) {
    sendLogMessage('error', 'Failed to process message', { error: error.message, stack: error.stack });
    // Don't respond to general errors - it could confuse clients expecting a specific ID
  }
});

// Only exit on explicit shutdown signals
process.on('SIGTERM', () => {
  sendLogMessage('info', 'Received SIGTERM signal, shutting down...');
  rl.close();
  if (pool) pool.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  sendLogMessage('info', 'Received SIGINT signal, shutting down...');
  rl.close();
  if (pool) pool.end();
  process.exit(0); 
});