# MCP Memory Server

This server implements long-term memory capabilities for AI assistants using mem0 principles, powered by PostgreSQL with pgvector for efficient vector similarity search.

## Features

- PostgreSQL with pgvector for vector similarity search
- Automatic embedding generation using BERT
- RESTful API for memory operations
- Semantic search capabilities
- Support for different types of memories (learnings, experiences, etc.)
- Tag-based memory retrieval
- Confidence scoring for memories
- Server-Sent Events (SSE) for real-time updates
- Cursor MCP protocol compatible

## Prerequisites

1. PostgreSQL 14+ with pgvector extension installed:
```bash
# In your PostgreSQL instance:
CREATE EXTENSION vector;
```

2. Node.js 16+

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
Copy `.env.sample` to `.env` and adjust the values:
```bash
cp .env.sample .env
```

Example `.env` configurations:
```bash
# With username/password
DATABASE_URL="postgresql://username:password@localhost:5432/mcp_memory"
PORT=3333

# Local development with peer authentication
DATABASE_URL="postgresql:///mcp_memory"
PORT=3333
```

3. Initialize the database:
```bash
npm run prisma:migrate
```

4. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Using with Cursor

### Adding the MCP Server in Cursor

To add the memory server to Cursor, you need to modify your MCP configuration file located at `~/.cursor/mcp.json`. Add the following configuration to the `mcpServers` object:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/path/to/your/memory/src/server.js"
      ]
    }
  }
}
```

Replace `/path/to/your/memory` with the actual path to your memory server installation.

For example, if you cloned the repository to `/Users/username/workspace/memory`, your configuration would look like:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/Users/username/workspace/memory/src/server.js"
      ]
    }
  }
}
```

The server will be automatically started by Cursor when needed. You can verify it's working by:
1. Opening Cursor
2. The memory server will be started automatically when Cursor launches
3. You can check the server status by visiting `http://localhost:3333/mcp/v1/health`

### Available MCP Endpoints

#### SSE Connection
- **Endpoint**: `GET /mcp/v1/sse`
- **Query Parameters**:
  - `subscribe`: Comma-separated list of events to subscribe to (optional)
- **Events**:
  - `connected`: Sent on initial connection
  - `memory.created`: Sent when new memories are created
  - `memory.updated`: Sent when existing memories are updated

#### Memory Operations
1. **Create Memory**
```http
POST /mcp/v1/memory
Content-Type: application/json

{
  "type": "learning",
  "content": {
    "topic": "Express.js",
    "details": "Express.js is a web application framework for Node.js"
  },
  "source": "documentation",
  "tags": ["nodejs", "web-framework"],
  "confidence": 0.95
}
```

2. **Search Memories**
```http
GET /mcp/v1/memory/search?query=web+frameworks&type=learning&tags=nodejs
```

3. **List Memories**
```http
GET /mcp/v1/memory?type=learning&tags=nodejs,web-framework
```

### Health Check
```http
GET /mcp/v1/health
```

### Response Format
All API responses follow the standard MCP format:
```json
{
  "status": "success",
  "data": {
    // Response data
  }
}
```

Or for errors:
```json
{
  "status": "error",
  "error": "Error message"
}
```

## Memory Schema

- id: Unique identifier
- type: Type of memory (learning, experience, etc.)
- content: Actual memory content (JSON)
- source: Where the memory came from
- embedding: Vector representation of the content (384 dimensions)
- tags: Array of relevant tags
- confidence: Confidence score (0-1)
- createdAt: When the memory was created
- updatedAt: When the memory was last updated 