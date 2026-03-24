'use strict';

const safeEqual = require('./safe-equal');

/**
 * A2A Protocol Compatibility Layer
 * Issue #187
 *
 * Bridges A2A Protocol v1.0 concepts to EClaw's entity model:
 * - AgentCard → entity.agentCard + metadata
 * - Task → mission_items (todoList)
 * - Message/Part → speak payload
 *
 * Mounted at: /api/a2a
 * Also: GET /.well-known/agent.json (platform-level card, mounted separately)
 *
 * Auth: Bearer token (deviceSecret or botSecret) in Authorization header
 */

const express = require('express');
const crypto = require('crypto');

module.exports = function (devices, { publicCodeIndex, serverLog, missionPool }) {
  const router = express.Router();

  // ── Auth: Accept Bearer token or query/body params ──

  function extractAuth(req) {
    // 1. Authorization: Bearer <secret>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return { bearerToken: authHeader.slice(7).trim() };
    }
    // 2. Query/body params
    const params = { ...req.query, ...req.body };
    return {
      deviceId: params.deviceId,
      deviceSecret: params.deviceSecret,
      botSecret: params.botSecret,
      entityId: params.entityId != null ? parseInt(params.entityId) : undefined
    };
  }

  function authenticateBearer(token) {
    // Try as deviceSecret: iterate devices
    for (const [deviceId, device] of Object.entries(devices)) {
      if (safeEqual(device.deviceSecret, token)) {
        return { type: 'device', deviceId, device };
      }
      // Try as botSecret: iterate entities
      for (const [eid, entity] of Object.entries(device.entities || {})) {
        if (safeEqual(entity.botSecret, token)) {
          return { type: 'bot', deviceId, entityId: parseInt(eid), entity };
        }
      }
    }
    return null;
  }

  function authenticate(req) {
    const auth = extractAuth(req);
    if (auth.bearerToken) {
      return authenticateBearer(auth.bearerToken);
    }
    if (auth.deviceSecret && auth.deviceId) {
      const device = devices[auth.deviceId];
      if (device && safeEqual(device.deviceSecret, auth.deviceSecret)) {
        return { type: 'device', deviceId: auth.deviceId, device };
      }
    }
    if (auth.botSecret && auth.deviceId) {
      const eid = auth.entityId || 0;
      const device = devices[auth.deviceId];
      if (device) {
        const entity = (device.entities || {})[eid];
        if (entity && safeEqual(entity.botSecret, auth.botSecret)) {
          return { type: 'bot', deviceId: auth.deviceId, entityId: eid, entity };
        }
      }
    }
    return null;
  }

  // ── Helper: EClaw entity → A2A AgentCard format ──

  function toA2AAgentCard(entity, publicCode) {
    const card = entity.agentCard || {};
    return {
      name: entity.name || `Entity ${publicCode}`,
      description: card.description || '',
      url: `https://eclawbot.com/api/a2a/agents/${publicCode}`,
      provider: {
        organization: 'EClaw',
        url: 'https://eclawbot.com'
      },
      version: card.version || '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: true,
        stateTransitionHistory: false
      },
      skills: (card.capabilities || []).map(c => ({
        id: c.id || c.name,
        name: c.name,
        description: c.description || ''
      })),
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      ...(card.tags && card.tags.length > 0 ? { tags: card.tags } : {}),
      ...(card.protocols && card.protocols.length > 0 ? { protocols: card.protocols } : {}),
      ...(card.website ? { website: card.website } : {}),
      ...(card.contactEmail ? { contactEmail: card.contactEmail } : {})
    };
  }

  // ── Helper: EClaw todo → A2A Task format ──

  function eclawStatusToA2A(status) {
    const map = {
      'PENDING': 'submitted',
      'IN_PROGRESS': 'working',
      'DONE': 'completed',
      'CANCELLED': 'canceled',
      'FAILED': 'failed'
    };
    return map[status] || 'submitted';
  }

  function a2aStatusToEclaw(status) {
    const map = {
      'submitted': 'PENDING',
      'working': 'IN_PROGRESS',
      'completed': 'DONE',
      'canceled': 'CANCELLED',
      'failed': 'FAILED',
      'input-required': 'PENDING'
    };
    return map[status] || 'PENDING';
  }

  function todoToA2ATask(todo) {
    return {
      id: todo.id,
      status: {
        state: eclawStatusToA2A(todo.status),
        timestamp: new Date(todo.updatedAt || todo.createdAt).toISOString()
      },
      history: [
        {
          role: todo.createdBy === 'bot' ? 'agent' : 'user',
          parts: [{ type: 'text', text: todo.title + (todo.description ? '\n\n' + todo.description : '') }]
        }
      ],
      metadata: {
        priority: todo.priority,
        assignedBot: todo.assignedBot,
        createdBy: todo.createdBy,
        source: 'eclaw'
      }
    };
  }

  // ── Platform Agent Card ──

  function getPlatformAgentCard() {
    return {
      name: 'EClaw Platform',
      description: 'Multi-device, multi-entity IoT agent platform with A2A messaging support.',
      url: 'https://eclawbot.com',
      provider: {
        organization: 'EClaw',
        url: 'https://eclawbot.com'
      },
      version: '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: true,
        stateTransitionHistory: false
      },
      skills: [
        { id: 'speak', name: 'Send Message', description: 'Send a message to an entity' },
        { id: 'broadcast', name: 'Broadcast', description: 'Broadcast message to all entities' },
        { id: 'task-management', name: 'Task Management', description: 'Create and manage tasks via mission dashboard' },
        { id: 'cross-speak', name: 'Cross-Device Messaging', description: 'Send messages across devices' }
      ],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      protocols: ['eclaw-v1', 'a2a-compat'],
      authentication: {
        schemes: ['bearer'],
        credentials: 'deviceSecret or botSecret as Bearer token'
      },
      supportsAuthenticatedExtendedCard: true
    };
  }

  // ── Routes ──

  // GET /api/a2a/agents/:publicCode — Per-entity A2A agent card
  router.get('/agents/:publicCode', (req, res) => {
    const { publicCode } = req.params;
    const entry = publicCodeIndex[publicCode];
    if (!entry) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32004, message: 'Agent not found' }
      });
    }

    const device = devices[entry.deviceId];
    if (!device) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32004, message: 'Agent not found' }
      });
    }

    const entity = (device.entities || {})[entry.entityId];
    if (!entity || !entity.isBound) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32004, message: 'Agent not found or not bound' }
      });
    }

    res.json(toA2AAgentCard(entity, publicCode));
  });

  // POST /api/a2a/tasks/send — Create or continue a task (JSON-RPC 2.0)
  router.post('/tasks/send', async (req, res) => {
    const authResult = authenticate(req);
    if (!authResult) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required. Use Bearer token (deviceSecret or botSecret).' }
      });
    }

    const { id, params } = req.body;
    const taskParams = params || req.body;
    const message = taskParams.message;
    const targetAgent = taskParams.targetAgent; // publicCode

    if (!message || !message.parts || message.parts.length === 0) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params: message with parts required' }
      });
    }

    // Extract text from parts
    const textParts = message.parts.filter(p => p.type === 'text');
    const text = textParts.map(p => p.text).join('\n');

    if (!text) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'No text content in message parts' }
      });
    }

    // Determine target device
    let targetDeviceId = authResult.deviceId;
    let assignedBot = null;

    if (targetAgent) {
      const entry = publicCodeIndex[targetAgent];
      if (!entry) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32004, message: `Target agent "${targetAgent}" not found` }
        });
      }
      targetDeviceId = entry.deviceId;
      assignedBot = String(entry.entityId);
    }

    // Create task via mission DB
    try {
      const client = await missionPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT init_mission_dashboard($1)', [targetDeviceId]);

        const dashResult = await client.query(
          'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
          [targetDeviceId]
        );
        const row = dashResult.rows[0];
        const todoList = row.todo_list || [];

        // Check for existing task (continue mode)
        const taskId = taskParams.id || crypto.randomUUID();
        const existingIdx = todoList.findIndex(t => t.id === taskParams.id);

        let task;
        if (existingIdx >= 0) {
          // Continue existing task — append message
          task = todoList[existingIdx];
          task.description = (task.description || '') + '\n\n---\n' + text;
          task.updatedAt = Date.now();
          task.status = task.status === 'DONE' ? 'IN_PROGRESS' : task.status;
        } else {
          // Create new task
          const title = text.length > 100 ? text.substring(0, 97) + '...' : text;
          task = {
            id: taskId,
            title,
            description: text,
            priority: taskParams.priority || 'MEDIUM',
            status: 'PENDING',
            assignedBot,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdBy: authResult.type === 'bot' ? `entity_${authResult.entityId}` : 'a2a_client'
          };
          todoList.push(task);
        }

        await client.query(
          'UPDATE mission_dashboard SET todo_list = $2, last_synced_at = NOW() WHERE device_id = $1',
          [targetDeviceId, JSON.stringify(todoList)]
        );
        await client.query('COMMIT');

        if (serverLog) {
          serverLog('info', 'a2a', `[A2A] Task ${existingIdx >= 0 ? 'continued' : 'created'}: "${task.title}"`, { deviceId: targetDeviceId });
        }

        res.json({
          jsonrpc: '2.0',
          id,
          result: todoToA2ATask(task)
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[A2A] tasks/send error:', err);
      res.status(500).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'Internal error' }
      });
    }
  });

  // GET /api/a2a/tasks/:taskId — Get task status
  router.get('/tasks/:taskId', async (req, res) => {
    const authResult = authenticate(req);
    if (!authResult) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required' }
      });
    }

    const { taskId } = req.params;
    const deviceId = req.query.deviceId || authResult.deviceId;

    try {
      const result = await missionPool.query(
        'SELECT todo_list FROM mission_dashboard WHERE device_id = $1',
        [deviceId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32004, message: 'Task not found' }
        });
      }

      const todoList = result.rows[0].todo_list || [];
      const task = todoList.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32004, message: 'Task not found' }
        });
      }

      res.json({
        jsonrpc: '2.0',
        result: todoToA2ATask(task)
      });
    } catch (err) {
      console.error('[A2A] tasks/get error:', err);
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' }
      });
    }
  });

  // POST /api/a2a/tasks/:taskId/cancel — Cancel a task
  router.post('/tasks/:taskId/cancel', async (req, res) => {
    const authResult = authenticate(req);
    if (!authResult) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required' }
      });
    }

    const { taskId } = req.params;
    const deviceId = req.body.deviceId || req.query.deviceId || authResult.deviceId;

    try {
      const client = await missionPool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          'SELECT todo_list FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
          [deviceId]
        );

        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32004, message: 'Task not found' }
          });
        }

        const todoList = result.rows[0].todo_list || [];
        const taskIdx = todoList.findIndex(t => t.id === taskId);

        if (taskIdx < 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32004, message: 'Task not found' }
          });
        }

        todoList[taskIdx].status = 'CANCELLED';
        todoList[taskIdx].updatedAt = Date.now();

        await client.query(
          'UPDATE mission_dashboard SET todo_list = $2, last_synced_at = NOW() WHERE device_id = $1',
          [deviceId, JSON.stringify(todoList)]
        );
        await client.query('COMMIT');

        if (serverLog) {
          serverLog('info', 'a2a', `[A2A] Task canceled: "${todoList[taskIdx].title}"`, { deviceId });
        }

        res.json({
          jsonrpc: '2.0',
          result: todoToA2ATask(todoList[taskIdx])
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[A2A] tasks/cancel error:', err);
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' }
      });
    }
  });

  return { router, getPlatformAgentCard };
};
