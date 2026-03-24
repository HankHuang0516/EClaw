'use strict';

const safeEqual = require('./safe-equal');

/**
 * gRPC Transport Layer
 * Issue #191
 *
 * Provides gRPC server alongside the Express HTTP server.
 * Delegates to the same in-memory devices object and REST handlers.
 *
 * Architecture:
 * - Uses @grpc/grpc-js (pure JS, no native deps)
 * - Loads proto via @grpc/proto-loader
 * - Runs on PORT+1 (or GRPC_PORT env var)
 * - All handlers are thin adapters that call existing REST logic
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, 'proto', 'eclaw.proto');

module.exports = function (devices, { serverLog } = {}) {

  // Load proto definition
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const eclawProto = protoDescriptor.eclaw.v1;

  // ── Service Implementations ──

  const healthService = {
    getHealth(_call, callback) {
      callback(null, {
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        version: 'grpc-1.0.0'
      });
    },

    getVersion(_call, callback) {
      callback(null, {
        buildId: 'grpc-server',
        version: '1.0.0',
        latestAppVersion: '1.0.46',
        forceUpdateBelow: ''
      });
    }
  };

  const entityService = {
    getStatus(call, callback) {
      const { deviceId, deviceSecret, entityId } = call.request;
      const device = devices[deviceId];
      if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid credentials' });
      }
      const entity = (device.entities || {})[entityId];
      if (!entity) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Entity not found' });
      }
      callback(null, {
        deviceId,
        entityId,
        name: entity.name || '',
        character: entity.character || '',
        state: entity.state || 'IDLE',
        message: entity.message || '',
        lastUpdated: entity.lastUpdated || 0,
        isBound: entity.isBound || false,
        xp: entity.xp || 0,
        level: entity.level || 0,
        publicCode: entity.publicCode || '',
        bindingType: entity.bindingType || ''
      });
    },

    listEntities(call, callback) {
      const { deviceId } = call.request;
      const entities = [];
      const targetDevices = deviceId ? { [deviceId]: devices[deviceId] } : devices;

      for (const [did, device] of Object.entries(targetDevices)) {
        if (!device || !device.entities) continue;
        for (const [eid, entity] of Object.entries(device.entities)) {
          if (entity.isBound) {
            entities.push({
              deviceId: did,
              entityId: parseInt(eid),
              name: entity.name || '',
              character: entity.character || '',
              state: entity.state || 'IDLE',
              message: entity.message || '',
              lastUpdated: entity.lastUpdated || 0,
              isBound: true,
              xp: entity.xp || 0,
              level: entity.level || 0,
              publicCode: entity.publicCode || '',
              bindingType: entity.bindingType || ''
            });
          }
        }
      }

      callback(null, {
        entities,
        activeCount: entities.length,
        deviceCount: Object.keys(targetDevices).length
      });
    },

    renameEntity(call, callback) {
      const { deviceId, deviceSecret, entityId, name } = call.request;
      const device = devices[deviceId];
      if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid credentials' });
      }
      const entity = (device.entities || {})[entityId];
      if (!entity) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Entity not found' });
      }
      entity.name = (name || '').substring(0, 20);
      entity.lastUpdated = Date.now();
      callback(null, { success: true, message: `Entity renamed to "${entity.name}"` });
    },

    lookupEntity(call, callback) {
      const { code } = call.request;
      // Search all devices for matching publicCode
      for (const [deviceId, device] of Object.entries(devices)) {
        for (const [eid, entity] of Object.entries(device.entities || {})) {
          if (entity.publicCode === code && entity.isBound) {
            return callback(null, {
              success: true,
              entity: {
                deviceId,
                entityId: parseInt(eid),
                name: entity.name || '',
                character: entity.character || '',
                state: entity.state || 'IDLE',
                message: entity.message || '',
                lastUpdated: entity.lastUpdated || 0,
                isBound: true,
                xp: entity.xp || 0,
                level: entity.level || 0,
                publicCode: entity.publicCode,
                bindingType: entity.bindingType || ''
              }
            });
          }
        }
      }
      callback({ code: grpc.status.NOT_FOUND, message: 'Entity not found' });
    }
  };

  const communicationService = {
    speak(call, callback) {
      const { deviceId, deviceSecret, entityId, text } = call.request;
      const device = devices[deviceId];
      if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid credentials' });
      }
      // Simplified: queue message for entity
      const entity = (device.entities || {})[entityId];
      if (!entity || !entity.isBound) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Entity not bound' });
      }
      if (!entity.pendingMessages) entity.pendingMessages = [];
      entity.pendingMessages.push({
        text,
        from: 'grpc_client',
        timestamp: Date.now(),
        read: false
      });
      callback(null, {
        success: true,
        message: 'Message queued via gRPC',
        targets: [{ entityId, pushed: false, mode: 'polling', reason: 'grpc', bindingType: entity.bindingType || '' }],
        broadcast: false
      });
    },

    speakTo(call, callback) {
      const { deviceId, fromEntityId, toEntityId, botSecret, text } = call.request;
      const device = devices[deviceId];
      if (!device) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Device not found' });
      }
      const fromEntity = (device.entities || {})[fromEntityId];
      if (!fromEntity || !safeEqual(fromEntity.botSecret, botSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid bot credentials' });
      }
      const toEntity = (device.entities || {})[toEntityId];
      if (!toEntity || !toEntity.isBound) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Target entity not found' });
      }
      if (!toEntity.pendingMessages) toEntity.pendingMessages = [];
      toEntity.pendingMessages.push({
        text,
        from: `entity_${fromEntityId}`,
        timestamp: Date.now(),
        read: false
      });
      callback(null, { success: true, message: 'Message delivered via gRPC', delivered: true });
    },

    broadcast(call, callback) {
      const { deviceId, fromEntityId, botSecret, text } = call.request;
      const device = devices[deviceId];
      if (!device) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Device not found' });
      }
      const fromEntity = (device.entities || {})[fromEntityId];
      if (!fromEntity || !safeEqual(fromEntity.botSecret, botSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid bot credentials' });
      }
      let sentCount = 0;
      const targets = [];
      for (const [eid, entity] of Object.entries(device.entities || {})) {
        if (parseInt(eid) !== fromEntityId && entity.isBound) {
          if (!entity.pendingMessages) entity.pendingMessages = [];
          entity.pendingMessages.push({
            text,
            from: `entity_${fromEntityId}`,
            timestamp: Date.now(),
            read: false
          });
          sentCount++;
          targets.push({ entityId: parseInt(eid), pushed: false, mode: 'polling', reason: 'grpc', bindingType: entity.bindingType || '' });
        }
      }
      callback(null, { success: true, message: `Broadcast to ${sentCount} entities`, sentCount, targets });
    },

    crossSpeak(call, callback) {
      // Cross-device speak via gRPC — simplified version
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Use REST API for cross-device messaging' });
    }
  };

  const missionService = {
    getDashboard(call, callback) {
      // Simplified: return empty dashboard (full implementation requires DB access)
      callback(null, {
        success: true,
        dashboardJson: JSON.stringify({ todoList: [], notes: [], rules: [], souls: [], skills: [] })
      });
    },

    addTodo(call, callback) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Use REST API for mission management' });
    }
  };

  const botService = {
    transform(call, callback) {
      const { deviceId, entityId, botSecret, state, message } = call.request;
      const device = devices[deviceId];
      if (!device) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Device not found' });
      }
      const entity = (device.entities || {})[entityId];
      if (!entity || !safeEqual(entity.botSecret, botSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid bot credentials' });
      }
      if (state) entity.state = state;
      if (message) entity.message = message;
      entity.lastUpdated = Date.now();
      callback(null, { success: true, message: 'State updated via gRPC' });
    },

    getPendingMessages(call, callback) {
      const { deviceId, entityId, botSecret } = call.request;
      const device = devices[deviceId];
      if (!device) {
        return callback({ code: grpc.status.NOT_FOUND, message: 'Device not found' });
      }
      const entity = (device.entities || {})[entityId];
      if (!entity || !safeEqual(entity.botSecret, botSecret)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Invalid bot credentials' });
      }
      const messages = entity.pendingMessages || [];
      callback(null, {
        deviceId,
        entityId,
        count: messages.length,
        messagesJson: JSON.stringify(messages)
      });
    }
  };

  // ── Server Setup ──

  function startGrpcServer(port) {
    const server = new grpc.Server();

    server.addService(eclawProto.HealthService.service, healthService);
    server.addService(eclawProto.EntityService.service, entityService);
    server.addService(eclawProto.CommunicationService.service, communicationService);
    server.addService(eclawProto.MissionService.service, missionService);
    server.addService(eclawProto.BotService.service, botService);

    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) {
        console.error('[gRPC] Failed to start server:', err.message);
        return;
      }
      console.log(`[gRPC] Server running on port ${boundPort}`);
      if (serverLog) {
        serverLog('info', 'grpc', `[gRPC] Server started on port ${boundPort}`);
      }
    });

    return server;
  }

  return { startGrpcServer, eclawProto };
};
