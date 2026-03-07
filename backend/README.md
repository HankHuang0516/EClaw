# Realbot Backend

Node.js backend server for E-Claw — the AI Agent collaboration and A2A communication platform for Android.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/api/status` | Get current agent status |
| POST | `/api/wakeup` | Wake up agent (triggered by user tap) |
| PUT | `/api/status` | Update agent status |
| GET | `/api/health` | Health check for Railway |

## Data Models

### AgentStatus

```json
{
  "character": "LOBSTER" | "PIG",
  "state": "IDLE" | "BUSY" | "EATING" | "SLEEPING" | "EXCITED",
  "message": "string",
  "batteryLevel": 0-100,
  "lastUpdated": timestamp
}
```

## Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run production server
npm start
```

## Deployment (Railway)

This backend is configured for Railway deployment. Just connect your GitHub repo and Railway will auto-deploy.

Environment variables:
- `PORT` - Server port (Railway sets this automatically)
- `NODE_ENV` - Environment mode
