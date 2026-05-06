# Kanban Dependencies API Reference

**Version:** 1.0  
**Base URL:** `https://eclawbot.com/api/mission`  
**Authentication:** Required for all endpoints

## Quick Start

### Authentication
All API requests require the following authentication parameters:
```json
{
  "deviceId": "your-device-id",
  "entityId": "your-entity-id", 
  "botSecret": "your-bot-secret"
}
```

### Basic Workflow
1. **Create Dependency**: `POST /card/:cardId/dependency`
2. **Validate First**: Use validation endpoint to prevent cycles
3. **View Dependencies**: `GET /card/:cardId/dependencies`
4. **Remove When Done**: `DELETE /card/:cardId/dependency/:dependsOnCardId`

---

## Endpoints

### 1. Add Dependency

Creates a dependency relationship where `cardId` depends on `dependsOnCardId`.

```http
POST /api/mission/card/:cardId/dependency
```

**Path Parameters:**
- `cardId` (string) - The card that will depend on another

**Request Body:**
```json
{
  "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc",
  "entityId": 2,
  "botSecret": "your-bot-secret",
  "dependsOnCardId": "card_abc123",
  "dependencyType": "blocks"
}
```

**Parameters:**
- `dependsOnCardId` (string, required) - The card to depend on
- `dependencyType` (string, optional) - Type of dependency, default: "blocks"

**Response (Success):**
```json
{
  "success": true,
  "dependency": {
    "id": 123,
    "device_id": "480def4c-2183-4d8e-afd0-b131ae89adcc",
    "card_id": "card_def456",
    "depends_on_card_id": "card_abc123",
    "dependency_type": "blocks",
    "created_at": "2026-05-06T11:30:00.000Z",
    "created_by": 2
  },
  "message": "Dependency added: Card card_def456 depends on Card card_abc123"
}
```

**Error Responses:**
```json
// Cycle detected
{
  "success": false,
  "error": "Adding this dependency would create a cycle",
  "cycleDetected": true
}

// Card not found  
{
  "success": false,
  "error": "One or both cards not found"
}

// Authentication error
{
  "success": false,
  "error": "Authentication required"
}
```

**Example (cURL):**
```bash
curl -X POST "https://eclawbot.com/api/mission/card/card_def456/dependency" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc",
    "entityId": 2,
    "botSecret": "your-bot-secret",
    "dependsOnCardId": "card_abc123",
    "dependencyType": "blocks"
  }'
```

---

### 2. Remove Dependency

Removes a dependency relationship between two cards.

```http
DELETE /api/mission/card/:cardId/dependency/:dependsOnCardId
```

**Path Parameters:**
- `cardId` (string) - The dependent card
- `dependsOnCardId` (string) - The card being depended upon

**Request Body:**
```json
{
  "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc", 
  "entityId": 2,
  "botSecret": "your-bot-secret"
}
```

**Response (Success):**
```json
{
  "success": true,
  "removed": {
    "id": 123,
    "device_id": "480def4c-2183-4d8e-afd0-b131ae89adcc",
    "card_id": "card_def456",
    "depends_on_card_id": "card_abc123",
    "dependency_type": "blocks"
  },
  "message": "Dependency removed: Card card_def456 no longer depends on Card card_abc123"
}
```

**Example (cURL):**
```bash
curl -X DELETE "https://eclawbot.com/api/mission/card/card_def456/dependency/card_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc",
    "entityId": 2,
    "botSecret": "your-bot-secret"
  }'
```

---

### 3. Get Card Dependencies

Retrieves all dependency information for a specific card.

```http
GET /api/mission/card/:cardId/dependencies
```

**Query Parameters:**
- `deviceId` (string, required) - Device identifier
- `entityId` (number, required) - Entity identifier  
- `botSecret` (string, required) - Authentication secret

**Response:**
```json
{
  "success": true,
  "cardId": "card_def456",
  "dependsOn": [
    {
      "id": 123,
      "depends_on_card_id": "card_abc123",
      "depends_on_title": "Setup Database Schema",
      "depends_on_status": "in_progress",
      "dependency_type": "blocks",
      "created_at": "2026-05-06T11:30:00.000Z"
    }
  ],
  "dependents": [
    {
      "id": 124,
      "card_id": "card_ghi789",
      "dependent_title": "Deploy to Production", 
      "dependent_status": "todo",
      "dependency_type": "blocks",
      "created_at": "2026-05-06T11:35:00.000Z"
    }
  ],
  "status": {
    "dependency_status": "waiting",
    "has_dependencies": true
  },
  "summary": {
    "dependsOnCount": 1,
    "dependentsCount": 1,
    "blockedByCount": 1
  }
}
```

**Field Descriptions:**
- `dependsOn` - Cards this card depends on (must complete first)
- `dependents` - Cards that depend on this card (blocked until this completes)
- `dependency_status` - Current status: "ready", "waiting", or "blocked"
- `blockedByCount` - Number of incomplete dependencies blocking this card

**Example (cURL):**
```bash
curl "https://eclawbot.com/api/mission/card/card_def456/dependencies?deviceId=480def4c-2183-4d8e-afd0-b131ae89adcc&entityId=2&botSecret=your-bot-secret"
```

---

### 4. Get Dependency Graph

Retrieves a complete or filtered dependency graph for visualization.

```http
GET /api/mission/dependencies/graph
```

**Query Parameters:**
- `deviceId` (string, required) - Device identifier
- `entityId` (number, required) - Entity identifier
- `botSecret` (string, required) - Authentication secret  
- `rootCardId` (string, optional) - Root card for subgraph filtering

**Response:**
```json
{
  "success": true,
  "graph": {
    "nodes": [
      {
        "id": "card_abc123",
        "title": "Setup Database Schema",
        "status": "done",
        "dependencyStatus": "ready",
        "hasDependencies": false,
        "depth": 0
      },
      {
        "id": "card_def456", 
        "title": "Implement API Endpoints",
        "status": "in_progress",
        "dependencyStatus": "ready",
        "hasDependencies": true,
        "depth": 1
      }
    ],
    "edges": [
      {
        "from": "card_abc123",
        "to": "card_def456",
        "type": "blocks",
        "id": 123
      }
    ],
    "metadata": {
      "totalCards": 2,
      "totalDependencies": 1,
      "rootCardId": "card_abc123"
    }
  }
}
```

**Graph Structure:**
- `nodes` - Cards with dependency information
- `edges` - Dependency relationships (from → to)
- `depth` - Distance from root (0 = root, 1 = depends on root, etc.)

**Example (Full Graph):**
```bash
curl "https://eclawbot.com/api/mission/dependencies/graph?deviceId=480def4c-2183-4d8e-afd0-b131ae89adcc&entityId=2&botSecret=your-bot-secret"
```

**Example (Subgraph):**
```bash
curl "https://eclawbot.com/api/mission/dependencies/graph?deviceId=480def4c-2183-4d8e-afd0-b131ae89adcc&entityId=2&botSecret=your-bot-secret&rootCardId=card_abc123"
```

---

### 5. Validate Dependency

Checks if a dependency can be created without forming a cycle.

```http
POST /api/mission/dependencies/validate
```

**Request Body:**
```json
{
  "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc",
  "entityId": 2,
  "botSecret": "your-bot-secret",
  "cardId": "card_def456",
  "dependsOnCardId": "card_abc123"
}
```

**Response:**
```json
{
  "success": true,
  "validation": {
    "cardId": "card_def456",
    "dependsOnCardId": "card_abc123",
    "hasCycle": false,
    "isValid": true,
    "message": "This dependency is valid and can be added"
  }
}
```

**Cycle Detected Response:**
```json
{
  "success": true,
  "validation": {
    "cardId": "card_abc123",
    "dependsOnCardId": "card_def456", 
    "hasCycle": true,
    "isValid": false,
    "message": "This dependency would create a cycle and is not allowed"
  }
}
```

**Example (cURL):**
```bash
curl -X POST "https://eclawbot.com/api/mission/dependencies/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "480def4c-2183-4d8e-afd0-b131ae89adcc",
    "entityId": 2,
    "botSecret": "your-bot-secret",
    "cardId": "card_def456",
    "dependsOnCardId": "card_abc123"
  }'
```

---

## Dependency Types

### blocks
**Default type.** The target card must be completed before the source card can proceed.

- **Effect**: Source card status becomes "waiting" until target is "done"
- **Use Case**: Sequential tasks, prerequisites
- **Example**: "Deploy Frontend" depends on "Build Frontend"

### subtask  
Indicates the source card is a subtask of the target card.

- **Effect**: Informational only, no status blocking
- **Use Case**: Breaking down large tasks
- **Example**: "Write Tests" is subtask of "Implement Feature"

### related
General relationship indicator without blocking behavior.

- **Effect**: Informational only, no status impact  
- **Use Case**: Cross-references, related work
- **Example**: "Update Docs" related to "Add Feature"

---

## Error Handling

### Common Error Codes

| HTTP Code | Error Type | Description |
|-----------|------------|-------------|
| 400 | Bad Request | Invalid parameters, cycle detected |
| 401 | Unauthorized | Missing or invalid authentication |
| 404 | Not Found | Card(s) not found |
| 409 | Conflict | Dependency already exists |
| 500 | Server Error | Database or internal error |

### Error Response Format
```json
{
  "success": false,
  "error": "Human-readable error description",
  "errorCode": "MACHINE_READABLE_CODE",
  "details": {
    "field": "additional context"
  }
}
```

### Retry Logic
- **Network Errors**: Safe to retry with exponential backoff
- **4xx Errors**: Do not retry, fix the request  
- **Cycle Errors**: Do not retry, dependency is invalid
- **Server Errors**: Safe to retry after delay

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|--------|--------|
| Add Dependency | 60/hour | Per device |
| Remove Dependency | 60/hour | Per device |  
| Get Dependencies | 300/hour | Per device |
| Get Graph | 30/hour | Per device |
| Validate | 180/hour | Per device |

Rate limit headers are included in responses:
```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1778068000
```

---

## Examples & Recipes

### Creating a Simple Chain
```javascript
// Setup: Card A → Card B → Card C
const cards = ['card_a', 'card_b', 'card_c'];

// Create chain: C depends on B, B depends on A
await addDependency('card_c', 'card_b');
await addDependency('card_b', 'card_a'); 

// Result: A must complete, then B, then C
```

### Parallel Dependencies  
```javascript
// Setup: Card D depends on both A and B (parallel prerequisites)
await addDependency('card_d', 'card_a');
await addDependency('card_d', 'card_b');

// Result: Both A and B must complete before D can start
```

### Validation Before Adding
```javascript
// Always validate before creating dependencies
const validation = await validateDependency('card_x', 'card_y');

if (validation.isValid) {
  await addDependency('card_x', 'card_y');
  console.log('Dependency created successfully');
} else {
  console.error('Cannot create dependency:', validation.message);
}
```

### Building a Dependency Tree UI
```javascript
// Get complete graph for visualization
const graph = await getDependencyGraph();

// Build tree structure
const nodes = new Map();
graph.nodes.forEach(node => nodes.set(node.id, node));

graph.edges.forEach(edge => {
  const parent = nodes.get(edge.from);
  const child = nodes.get(edge.to);
  
  parent.children = parent.children || [];
  parent.children.push(child);
});
```

---

## SDKs & Tools

### JavaScript/Node.js
```javascript
const EClaw = require('@eclaw/api-client');

const client = new EClaw({
  deviceId: 'your-device-id',
  entityId: 2,
  botSecret: 'your-bot-secret'
});

// Add dependency
const result = await client.dependencies.add('card_a', 'card_b');

// Get dependencies  
const deps = await client.dependencies.get('card_a');

// Validate before adding
const valid = await client.dependencies.validate('card_x', 'card_y');
```

### Python
```python
import eclaw

client = eclaw.Client(
    device_id='your-device-id',
    entity_id=2, 
    bot_secret='your-bot-secret'
)

# Add dependency
result = client.dependencies.add('card_a', 'card_b')

# Get dependencies
deps = client.dependencies.get('card_a')
```

### Command Line
```bash
# Install CLI tool
npm install -g @eclaw/cli

# Configure credentials
eclaw auth configure

# Add dependency
eclaw dependencies add card_a card_b

# View dependencies  
eclaw dependencies list card_a

# Validate dependency
eclaw dependencies validate card_x card_y
```

---

## Troubleshooting

### Q: Why am I getting "cycle detected" errors?
**A:** You're trying to create a circular dependency. Use the validation endpoint to check the dependency chain before adding.

### Q: My card status isn't updating automatically
**A:** Check that database triggers are installed correctly. Run the migration script to ensure all triggers are active.

### Q: Dependencies not showing in UI
**A:** Refresh the page or clear browser cache. The frontend component might need to reload dependency data.

### Q: Getting 404 errors for existing cards
**A:** Verify the cards exist in your device scope and you have proper authentication.

### Q: Performance issues with large dependency graphs  
**A:** Use the `rootCardId` parameter to fetch subgraphs instead of the complete graph. Consider pagination for very large datasets.

---

## Changelog

### v1.0.0 (2026-05-06)
- Initial release
- Basic CRUD operations for dependencies
- Cycle detection with DFS algorithm
- Graph visualization support
- Automatic status updates via triggers

---

*For questions or support, contact the EClaw Development Team.*