const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// MULTI-ENTITY BINDING ARCHITECTURE
// Each entity (0-3) has its own binding code
// ============================================

const MAX_ENTITIES = 4;

// Entity slots - each has independent binding
const entitySlots = {};

// Initialize all 4 slots
for (let i = 0; i < MAX_ENTITIES; i++) {
    entitySlots[i] = {
        entityId: i,
        // Binding info
        bindingCode: null,
        bindingCodeExpires: null,
        deviceId: null,
        deviceSecret: null,
        isBound: false,
        // Agent state
        character: i % 2 === 0 ? "LOBSTER" : "PIG", // Alternate default
        state: "IDLE",
        message: `Entity #${i} waiting...`,
        parts: {},
        batteryLevel: 100,
        lastUpdated: Date.now(),
        // Message queue for this entity
        messageQueue: []
    };
}

// Helper: Generate 6-digit binding code
function generateBindingCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper: Load MCP skill documentation
function loadSkillDoc() {
    try {
        const docPath = path.join(__dirname, 'E-claw_mcp_skill.md');
        return fs.readFileSync(docPath, 'utf8');
    } catch (err) {
        return "MCP Skill documentation not found.";
    }
}

// Auto-decay loop for ALL entities
setInterval(() => {
    const now = Date.now();
    for (let i = 0; i < MAX_ENTITIES; i++) {
        const entity = entitySlots[i];
        if (!entity.isBound) continue; // Skip unbound entities

        // 1. Battery Decay
        if (entity.batteryLevel > 0) entity.batteryLevel -= 1;

        // 2. Random State Change (Idle vs Sleep) if no updates for 20s
        if (now - entity.lastUpdated > 20000) {
            if (Math.random() > 0.7) {
                entity.state = "SLEEPING";
                entity.message = "Zzz...";
            } else {
                entity.state = "IDLE";
                entity.message = "Waiting...";
            }
            entity.lastUpdated = now;
        }
    }
}, 5000);

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
    const boundCount = Object.values(entitySlots).filter(e => e.isBound).length;
    res.send(`Claw Backend Running! Bound Entities: ${boundCount}/${MAX_ENTITIES}`);
});

// Railway Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// DEVICE REGISTRATION (Android App)
// ============================================

/**
 * POST /api/device/register
 * Android app registers a specific entity slot and gets binding code.
 * Body: { entityId: 0-3, deviceId: "...", deviceSecret: "..." }
 */
app.post('/api/device/register', (req, res) => {
    const { entityId, deviceId, deviceSecret } = req.body;

    // entityId is optional, defaults to 0 for backward compatibility
    const eId = entityId !== undefined ? parseInt(entityId) : 0;
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({
            success: false,
            message: `Invalid entityId. Must be 0-${MAX_ENTITIES - 1}`
        });
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({
            success: false,
            message: "deviceId and deviceSecret required"
        });
    }

    const entity = entitySlots[eId];

    // Generate new binding code
    const code = generateBindingCode();
    entity.bindingCode = code;
    entity.bindingCodeExpires = Date.now() + (5 * 60 * 1000); // 5 minutes
    entity.deviceId = deviceId;
    entity.deviceSecret = deviceSecret;

    console.log(`[Register] Entity ${eId}: Code ${code} for device ${deviceId}`);

    res.json({
        success: true,
        entityId: eId,
        bindingCode: code,
        expiresIn: 300 // 5 minutes in seconds
    });
});

/**
 * POST /api/device/status
 * Android app polls for entity status using deviceId + secret.
 * Body: { entityId: 0-3, deviceId: "...", deviceSecret: "..." }
 */
app.post('/api/device/status', (req, res) => {
    const { entityId, deviceId, deviceSecret } = req.body;

    // entityId is optional, defaults to 0 for backward compatibility
    const eId = entityId !== undefined ? parseInt(entityId) : 0;
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];

    // Verify device owns this entity (skip if no device registered yet)
    if (entity.deviceId && (entity.deviceId !== deviceId || entity.deviceSecret !== deviceSecret)) {
        return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    res.json({
        entityId: entity.entityId,
        character: entity.character,
        state: entity.state,
        message: entity.message,
        parts: entity.parts,
        batteryLevel: entity.batteryLevel,
        lastUpdated: entity.lastUpdated,
        isBound: entity.isBound
    });
});

// ============================================
// BOT BINDING (OpenClaw)
// ============================================

/**
 * POST /api/bind
 * Bot binds to a specific entity using binding code.
 * Body: { code: "123456", entityId: 0-3 (optional, will search if not provided) }
 */
app.post('/api/bind', (req, res) => {
    const { code, entityId } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, message: "Binding code required" });
    }

    let targetEntity = null;

    // If entityId provided, check that specific slot
    if (entityId !== undefined) {
        const eId = parseInt(entityId);
        if (!isNaN(eId) && eId >= 0 && eId < MAX_ENTITIES) {
            const entity = entitySlots[eId];
            if (entity.bindingCode === code && entity.bindingCodeExpires > Date.now()) {
                targetEntity = entity;
            }
        }
    } else {
        // Search all slots for matching code
        for (let i = 0; i < MAX_ENTITIES; i++) {
            const entity = entitySlots[i];
            if (entity.bindingCode === code && entity.bindingCodeExpires > Date.now()) {
                targetEntity = entity;
                break;
            }
        }
    }

    if (!targetEntity) {
        return res.status(400).json({
            success: false,
            message: "Invalid or expired binding code"
        });
    }

    // Mark as bound
    targetEntity.isBound = true;
    targetEntity.bindingCode = null; // Clear code after use
    targetEntity.state = "IDLE";
    targetEntity.message = "Connected!";
    targetEntity.lastUpdated = Date.now();

    console.log(`[Bind] Entity ${targetEntity.entityId} bound successfully`);

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
        success: true,
        message: `Entity ${targetEntity.entityId} bound successfully`,
        entityId: targetEntity.entityId,
        deviceInfo: {
            id: targetEntity.deviceId,
            entityId: targetEntity.entityId,
            status: "ONLINE"
        },
        skills_documentation_url: `${baseUrl}/api/skills-doc`
    });
});

/**
 * GET /api/skills-doc
 * Returns the MCP skill documentation as plain text.
 * Bots should fetch this URL after binding to learn available skills.
 */
app.get('/api/skills-doc', (req, res) => {
    const doc = loadSkillDoc();
    res.type('text/markdown').send(doc);
});

// ============================================
// ENTITY STATUS & CONTROL
// ============================================

/**
 * GET /api/entities
 * Get all bound entities.
 */
app.get('/api/entities', (req, res) => {
    const entities = [];
    for (let i = 0; i < MAX_ENTITIES; i++) {
        const entity = entitySlots[i];
        if (entity.isBound) {
            entities.push({
                entityId: entity.entityId,
                character: entity.character,
                state: entity.state,
                message: entity.message,
                parts: entity.parts,
                batteryLevel: entity.batteryLevel,
                lastUpdated: entity.lastUpdated
            });
        }
    }

    res.json({
        entities: entities,
        activeCount: entities.length,
        maxEntities: MAX_ENTITIES
    });
});

/**
 * GET /api/status
 * Get status for specific entity (default: 0).
 * Query: ?entityId=0
 */
app.get('/api/status', (req, res) => {
    const eId = parseInt(req.query.entityId) || 0;

    if (eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];

    res.json({
        entityId: entity.entityId,
        character: entity.character,
        state: entity.state,
        message: entity.message,
        parts: entity.parts,
        batteryLevel: entity.batteryLevel,
        lastUpdated: entity.lastUpdated,
        isBound: entity.isBound
    });
});

/**
 * POST /api/transform
 * Update entity status (Bot uses this).
 * Body: { entityId: 0-3, character, state, message, parts }
 */
app.post('/api/transform', (req, res) => {
    const { entityId, character, state, message, parts } = req.body;

    const eId = parseInt(entityId) || 0;

    if (eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];

    if (!entity.isBound) {
        return res.status(400).json({
            success: false,
            message: `Entity ${eId} is not bound yet`
        });
    }

    if (character) entity.character = character;
    if (state) entity.state = state;
    if (message !== undefined) entity.message = message;
    if (parts) entity.parts = { ...entity.parts, ...parts };
    if (entity.batteryLevel < 10) entity.batteryLevel = 100;

    entity.lastUpdated = Date.now();

    console.log(`[Transform] Entity ${eId}: ${state || entity.state} - "${message || entity.message}"`);

    res.json({
        success: true,
        entityId: eId,
        currentState: {
            entityId: entity.entityId,
            character: entity.character,
            state: entity.state,
            message: entity.message,
            parts: entity.parts
        }
    });
});

/**
 * POST /api/wakeup
 * Wake up specific entity.
 * Body: { entityId: 0-3 }
 */
app.post('/api/wakeup', (req, res) => {
    const eId = parseInt(req.body.entityId) || parseInt(req.query.entityId) || 0;

    if (eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];

    if (!entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} not bound` });
    }

    entity.state = "EXCITED";
    entity.message = "I'm Awake!";
    entity.lastUpdated = Date.now();

    setTimeout(() => {
        if (entity.state === "EXCITED") {
            entity.state = "IDLE";
            entity.message = "Ready.";
        }
    }, 5000);

    console.log(`[Wakeup] Entity ${eId}`);
    res.json({ success: true, message: `Entity ${eId} woken up` });
});

// ============================================
// ENTITY-TO-ENTITY MESSAGING
// ============================================

/**
 * POST /api/entity/:from/speak-to/:to
 * Send message from one entity to another.
 */
app.post('/api/entity/:from/speak-to/:to', (req, res) => {
    const fromId = parseInt(req.params.from);
    const toId = parseInt(req.params.to);
    const { text } = req.body;

    if (isNaN(fromId) || isNaN(toId) || fromId < 0 || fromId >= MAX_ENTITIES || toId < 0 || toId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entity IDs" });
    }

    if (!text) {
        return res.status(400).json({ success: false, message: "Text required" });
    }

    const fromEntity = entitySlots[fromId];
    const toEntity = entitySlots[toId];

    if (!fromEntity.isBound || !toEntity.isBound) {
        return res.status(400).json({ success: false, message: "Both entities must be bound" });
    }

    // Add to recipient's queue
    toEntity.messageQueue.push({
        text: text,
        from: `entity-${fromId}`,
        fromCharacter: fromEntity.character,
        timestamp: Date.now(),
        read: false
    });

    console.log(`[Msg] Entity ${fromId} -> Entity ${toId}: "${text}"`);

    res.json({ success: true, message: "Message sent" });
});

/**
 * POST /api/entity/broadcast
 * Broadcast message from one entity to all others.
 */
app.post('/api/entity/broadcast', (req, res) => {
    const { from, text } = req.body;

    const fromId = parseInt(from);
    if (isNaN(fromId) || fromId < 0 || fromId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid from entity ID" });
    }

    if (!text) {
        return res.status(400).json({ success: false, message: "Text required" });
    }

    const fromEntity = entitySlots[fromId];
    if (!fromEntity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${fromId} not bound` });
    }

    let sentCount = 0;
    for (let i = 0; i < MAX_ENTITIES; i++) {
        if (i === fromId) continue;
        const entity = entitySlots[i];
        if (entity.isBound) {
            entity.messageQueue.push({
                text: text,
                from: `entity-${fromId}`,
                fromCharacter: fromEntity.character,
                timestamp: Date.now(),
                read: false
            });
            sentCount++;
        }
    }

    console.log(`[Broadcast] Entity ${fromId} -> ${sentCount} entities: "${text}"`);

    res.json({ success: true, message: `Broadcast to ${sentCount} entities` });
});

/**
 * GET /api/client/pending
 * Get pending messages for entity.
 * Query: ?entityId=0
 */
app.get('/api/client/pending', (req, res) => {
    const eId = parseInt(req.query.entityId) || 0;

    if (eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];
    const pending = entity.messageQueue.filter(m => !m.read);
    pending.forEach(m => m.read = true);

    res.json({
        entityId: eId,
        count: pending.length,
        messages: pending
    });
});

/**
 * POST /api/client/speak
 * Client sends message (stored in entity's queue).
 */
app.post('/api/client/speak', (req, res) => {
    const eId = parseInt(req.body.entityId) || parseInt(req.query.entityId) || 0;
    const { text } = req.body;

    if (eId < 0 || eId >= MAX_ENTITIES) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = entitySlots[eId];

    entity.message = `Received: "${text}"`;
    entity.lastUpdated = Date.now();

    entity.messageQueue.push({
        text: text,
        from: "client",
        timestamp: Date.now(),
        read: false
    });

    console.log(`[Client] -> Entity ${eId}: "${text}"`);
    res.json({ success: true, message: "Received" });
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

/**
 * GET /api/debug/slots
 * Show all entity slots (for debugging).
 */
app.get('/api/debug/slots', (req, res) => {
    const slots = [];
    for (let i = 0; i < MAX_ENTITIES; i++) {
        const e = entitySlots[i];
        slots.push({
            entityId: i,
            isBound: e.isBound,
            hasActiveCode: e.bindingCode !== null && e.bindingCodeExpires > Date.now(),
            bindingCode: e.bindingCode, // Show for debugging
            character: e.character,
            state: e.state,
            message: e.message
        });
    }
    res.json({ slots });
});

/**
 * POST /api/debug/reset
 * Reset all entities (for testing).
 */
app.post('/api/debug/reset', (req, res) => {
    for (let i = 0; i < MAX_ENTITIES; i++) {
        entitySlots[i] = {
            entityId: i,
            bindingCode: null,
            bindingCodeExpires: null,
            deviceId: null,
            deviceSecret: null,
            isBound: false,
            character: i % 2 === 0 ? "LOBSTER" : "PIG",
            state: "IDLE",
            message: `Entity #${i} waiting...`,
            parts: {},
            batteryLevel: 100,
            lastUpdated: Date.now(),
            messageQueue: []
        };
    }
    console.log("[Debug] All entities reset");
    res.json({ success: true, message: "All entities reset" });
});

// Error Handling
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, message: "Invalid JSON format" });
    }
    next();
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Claw Backend running on port ${port}`);
    console.log(`Entity slots: ${MAX_ENTITIES}`);
});
