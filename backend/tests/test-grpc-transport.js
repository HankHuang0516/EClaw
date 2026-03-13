#!/usr/bin/env node
'use strict';

/**
 * Regression test for Issue #191 — gRPC Transport
 *
 * Verifies:
 * 1. Proto file loads correctly
 * 2. gRPC server starts and binds to port
 * 3. HealthService.GetHealth returns valid response
 * 4. EntityService.ListEntities works
 * 5. EntityService.GetStatus rejects invalid credentials
 * 6. CommunicationService.Speak rejects invalid credentials
 *
 * No external credentials needed — runs against local gRPC server.
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'eclaw.proto');
const TEST_PORT = 50199; // Use high port to avoid conflicts

let passed = 0;
let failed = 0;
let server;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function rpcCall(client, method) {
  return new Promise((resolve, reject) => {
    const args = Array.from(arguments).slice(2);
    const request = args[0] || {};
    client[method](request, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

async function main() {
  console.log(`\n🧪 gRPC Transport Regression Test (port ${TEST_PORT})\n`);

  // Set up test devices
  const devices = {
    'test-device-grpc': {
      deviceId: 'test-device-grpc',
      deviceSecret: 'test-secret-grpc',
      entities: {
        0: { name: 'Test Bot', character: 'bot', state: 'IDLE', message: '', isBound: true, xp: 100, level: 3, publicCode: 'GRPCTEST', bindingType: 'personal', botSecret: 'bot-secret-123', pendingMessages: [] },
        1: { name: null, character: 'default', state: 'IDLE', message: '', isBound: false, xp: 0, level: 0, publicCode: '', bindingType: null }
      }
    }
  };

  // Test 1: Proto loads
  console.log('Test 1: Proto file loads correctly');
  let eclawProto;
  {
    try {
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: false, longs: String, enums: String, defaults: true, oneofs: true
      });
      const descriptor = grpc.loadPackageDefinition(packageDefinition);
      eclawProto = descriptor.eclaw.v1;
      assert(true, 'Proto loaded');
      assert(eclawProto.HealthService, 'HealthService defined');
      assert(eclawProto.EntityService, 'EntityService defined');
      assert(eclawProto.CommunicationService, 'CommunicationService defined');
      assert(eclawProto.MissionService, 'MissionService defined');
      assert(eclawProto.BotService, 'BotService defined');
    } catch (err) {
      assert(false, `Proto load failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Test 2: gRPC server starts
  console.log('\nTest 2: gRPC server starts');
  {
    try {
      const grpcModule = require('../grpc-server')(devices, { serverLog: null });
      server = new grpc.Server();
      // Add services manually for test
      server.addService(eclawProto.HealthService.service, {
        getHealth: (_, cb) => cb(null, { status: 'ok', timestamp: Date.now(), uptime: 1, version: 'test' }),
        getVersion: (_, cb) => cb(null, { buildId: 'test', version: '1.0.0', latestAppVersion: '1.0.0', forceUpdateBelow: '' })
      });
      // Use the real module's server for other services
      const realModule = require('../grpc-server')(devices, { serverLog: null });
      server = null; // discard temp server

      await new Promise((resolve, reject) => {
        const s = new grpc.Server();
        // Re-init with real module
        const grpcMod = require('../grpc-server')(devices, { serverLog: null });
        server = grpcMod.startGrpcServer(TEST_PORT);
        // Give it time to bind
        setTimeout(resolve, 500);
      });

      assert(true, `Server started on port ${TEST_PORT}`);
    } catch (err) {
      assert(false, `Server start failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Create clients
  const healthClient = new eclawProto.HealthService(`localhost:${TEST_PORT}`, grpc.credentials.createInsecure());
  const entityClient = new eclawProto.EntityService(`localhost:${TEST_PORT}`, grpc.credentials.createInsecure());
  const commClient = new eclawProto.CommunicationService(`localhost:${TEST_PORT}`, grpc.credentials.createInsecure());

  // Test 3: HealthService.GetHealth
  console.log('\nTest 3: HealthService.GetHealth');
  {
    try {
      const res = await rpcCall(healthClient, 'getHealth', {});
      assert(res.status === 'ok', `Status: ${res.status}`);
      assert(res.timestamp > 0, `Timestamp: ${res.timestamp}`);
      assert(res.uptime >= 0, `Uptime: ${res.uptime}`);
      assert(res.version, `Version: ${res.version}`);
    } catch (err) {
      assert(false, `RPC failed: ${err.message}`);
    }
  }

  // Test 4: EntityService.ListEntities
  console.log('\nTest 4: EntityService.ListEntities');
  {
    try {
      const res = await rpcCall(entityClient, 'listEntities', { deviceId: 'test-device-grpc' });
      assert(res.activeCount >= 1, `Active count: ${res.activeCount}`);
      assert(res.entities && res.entities.length >= 1, `Entities found: ${res.entities?.length}`);
      if (res.entities && res.entities.length > 0) {
        assert(res.entities[0].name === 'Test Bot', `First entity name: ${res.entities[0].name}`);
        assert(res.entities[0].publicCode === 'GRPCTEST', `Public code: ${res.entities[0].publicCode}`);
      }
    } catch (err) {
      assert(false, `RPC failed: ${err.message}`);
    }
  }

  // Test 5: EntityService.GetStatus — invalid credentials
  console.log('\nTest 5: EntityService.GetStatus — invalid credentials');
  {
    try {
      await rpcCall(entityClient, 'getStatus', {
        deviceId: 'test-device-grpc',
        deviceSecret: 'wrong-secret',
        entityId: 0
      });
      assert(false, 'Should have rejected invalid credentials');
    } catch (err) {
      assert(err.code === grpc.status.PERMISSION_DENIED, `gRPC PERMISSION_DENIED (code ${err.code})`);
    }
  }

  // Test 6: EntityService.GetStatus — valid credentials
  console.log('\nTest 6: EntityService.GetStatus — valid credentials');
  {
    try {
      const res = await rpcCall(entityClient, 'getStatus', {
        deviceId: 'test-device-grpc',
        deviceSecret: 'test-secret-grpc',
        entityId: 0
      });
      assert(res.name === 'Test Bot', `Name: ${res.name}`);
      assert(res.isBound === true, 'Is bound');
      assert(res.level === 3, `Level: ${res.level}`);
    } catch (err) {
      assert(false, `RPC failed: ${err.message}`);
    }
  }

  // Test 7: CommunicationService.Speak — invalid credentials
  console.log('\nTest 7: CommunicationService.Speak — invalid credentials');
  {
    try {
      await rpcCall(commClient, 'speak', {
        deviceId: 'test-device-grpc',
        deviceSecret: 'wrong',
        entityId: 0,
        text: 'test'
      });
      assert(false, 'Should have rejected');
    } catch (err) {
      assert(err.code === grpc.status.PERMISSION_DENIED, `gRPC PERMISSION_DENIED (code ${err.code})`);
    }
  }

  // Cleanup
  healthClient.close();
  entityClient.close();
  commClient.close();
  if (server) {
    server.forceShutdown();
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('All tests passed! ✅\n');
}

main().catch(err => {
  console.error('Test runner error:', err.message);
  if (server) server.forceShutdown();
  process.exit(1);
});
