/**
 * Mission Control Dashboard - Unit Tests
 * PostgreSQL + Optimistic Locking
 */

const { expect } = require('chai');
const request = require('supertest');
const app = require('../index'); // Main app
const pool = require('../db');  // Database pool

describe('Mission Control Dashboard API', () => {
    
    const testDeviceId = 'test-device-' + Date.now();
    const testBotSecret = 'test-secret-123';
    const testEntityId = 1;
    
    before(async () => {
        // Initialize test database
        await pool.query('SELECT init_mission_dashboard($1)', [testDeviceId]);
    });
    
    after(async () => {
        // Cleanup test data
        await pool.query('DELETE FROM mission_items WHERE device_id = $1', [testDeviceId]);
        await pool.query('DELETE FROM mission_notes WHERE device_id = $1', [testDeviceId]);
        await pool.query('DELETE FROM mission_rules WHERE device_id = $1', [testDeviceId]);
        await pool.query('DELETE FROM mission_dashboard WHERE device_id = $1', [testDeviceId]);
        await pool.end();
    });
    
    // ============================================
    // Dashboard Tests
    // ============================================
    
    describe('GET /api/mission/dashboard', () => {
        it('should return dashboard for valid credentials', async () => {
            const res = await request(app)
                .get('/api/mission/dashboard')
                .query({ 
                    deviceId: testDeviceId, 
                    entityId: testEntityId,
                    botSecret: testBotSecret 
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.dashboard).to.have.property('deviceId', testDeviceId);
            expect(res.body.dashboard).to.have.property('version', 1);
        });
        
        it('should return 400 for missing credentials', async () => {
            const res = await request(app)
                .get('/api/mission/dashboard')
                .query({ deviceId: testDeviceId });
            
            expect(res.status).to.equal(400);
            expect(res.body.success).to.equal(false);
        });
    });
    
    describe('POST /api/mission/dashboard', () => {
        it('should upload dashboard successfully', async () => {
            const dashboard = {
                todoList: [{ id: '1', title: 'Test Task', priority: 2 }],
                missionList: [],
                doneList: [],
                notes: [],
                rules: []
            };
            
            const res = await request(app)
                .post('/api/mission/dashboard')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    dashboard,
                    version: 1
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.version).to.equal(2); // Version auto-incremented
        });
        
        it('should reject version conflict', async () => {
            const dashboard = {
                todoList: [{ id: '2', title: 'Updated Task', priority: 3 }],
                missionList: [],
                doneList: [],
                notes: [],
                rules: []
            };
            
            // Try to upload with old version
            const res = await request(app)
                .post('/api/mission/dashboard')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    dashboard,
                    version: 1 // Old version - should conflict!
                });
            
            expect(res.status).to.equal(409);
            expect(res.body.error).to.equal('VERSION_CONFLICT');
            expect(res.body).to.have.property('currentVersion');
            expect(res.body).to.have.property('yourVersion', 1);
        });
    });
    
    // ============================================
    // Mission Items Tests
    // ============================================
    
    describe('GET /api/mission/items', () => {
        it('should return items for valid credentials', async () => {
            const res = await request(app)
                .get('/api/mission/items')
                .query({ 
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret 
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.items).to.be.an('array');
        });
        
        it('should filter by status', async () => {
            const res = await request(app)
                .get('/api/mission/items')
                .query({ 
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    status: 'PENDING'
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.items.every(i => i.status === 'PENDING')).to.equal(true);
        });
    });
    
    describe('POST /api/mission/items', () => {
        it('should create new item', async () => {
            const item = {
                id: 'test-item-' + Date.now(),
                title: 'New Task',
                description: 'Test description',
                priority: 3,
                status: 'PENDING'
            };
            
            const res = await request(app)
                .post('/api/mission/items')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    item,
                    listType: 'todo'
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.item.title).to.equal('New Task');
            expect(res.body.item.priority).to.equal(3);
        });
    });
    
    describe('PUT /api/mission/items/:id', () => {
        let testItemId;
        
        before(async () => {
            // Create a test item
            const item = {
                id: 'update-test-' + Date.now(),
                title: 'To Be Updated',
                priority: 2
            };
            
            await request(app)
                .post('/api/mission/items')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    item,
                    listType: 'todo'
                });
            
            testItemId = item.id;
        });
        
        it('should update item', async () => {
            const res = await request(app)
                .put(`/api/mission/items/${testItemId}`)
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    item: {
                        title: 'Updated Title',
                        status: 'IN_PROGRESS',
                        priority: 4
                    }
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
        });
    });
    
    describe('DELETE /api/mission/items/:id', () => {
        it('should delete item', async () => {
            // Create item first
            const item = {
                id: 'delete-test-' + Date.now(),
                title: 'To Be Deleted'
            };
            
            await request(app)
                .post('/api/mission/items')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    item,
                    listType: 'todo'
                });
            
            // Delete it
            const res = await request(app)
                .delete(`/api/mission/items/${item.id}`)
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret
                });
            
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
        });
    });
    
    // ============================================
    // Notes Tests
    // ============================================
    
    describe('GET /api/mission/notes', () => {
        it('should return notes for valid credentials', async () => {
            const res = await request(app)
                .get('/api/mission/notes')
                .query({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret
                });

            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.notes).to.be.an('array');
        });

        // Regression: the handler used to read from the legacy mission_notes
        // table (never written to), so notes added via /note/add were
        // invisible here. This proves /notes now reads from the same source
        // as /dashboard — mission_dashboard.notes JSON column.
        it('should return notes added via /note/add (same source as dashboard)', async () => {
            const title = 'regression-probe-' + Date.now();
            const addRes = await request(app)
                .post('/api/mission/note/add')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    title,
                    content: 'probe',
                    category: 'general'
                });
            expect(addRes.status).to.equal(200);

            const res = await request(app)
                .get('/api/mission/notes')
                .query({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret
                });
            expect(res.status).to.equal(200);
            const titles = (res.body.notes || []).map(n => n.title);
            expect(titles).to.include(title);
        });

        it('should filter by category query param', async () => {
            const catA = 'cat-a-' + Date.now();
            const catB = 'cat-b-' + Date.now();
            await request(app).post('/api/mission/note/add').send({
                deviceId: testDeviceId, entityId: testEntityId, botSecret: testBotSecret,
                title: 'note-a-' + Date.now(), content: 'x', category: catA
            });
            await request(app).post('/api/mission/note/add').send({
                deviceId: testDeviceId, entityId: testEntityId, botSecret: testBotSecret,
                title: 'note-b-' + Date.now(), content: 'y', category: catB
            });
            const res = await request(app)
                .get('/api/mission/notes')
                .query({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    category: catA
                });
            expect(res.status).to.equal(200);
            const cats = (res.body.notes || []).map(n => n.category);
            expect(cats.every(c => c === catA)).to.equal(true);
        });
    });
    
    // ============================================
    // Rules Tests
    // ============================================
    
    describe('GET /api/mission/rules', () => {
        it('should return rules for valid credentials', async () => {
            const res = await request(app)
                .get('/api/mission/rules')
                .query({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret
                });

            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            expect(res.body.rules).to.be.an('array');
        });

        // Same regression as /notes — handler used to read from the legacy
        // mission_rules table that receives no writes.
        it('should return rules added via /rule/add (same source as dashboard)', async () => {
            const probeName = 'regression-rule-' + Date.now();
            const addRes = await request(app)
                .post('/api/mission/rule/add')
                .send({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret,
                    name: probeName,
                    description: 'regression probe',
                    ruleType: 'WORKFLOW'
                });
            expect(addRes.status).to.equal(200);

            const res = await request(app)
                .get('/api/mission/rules')
                .query({
                    deviceId: testDeviceId,
                    entityId: testEntityId,
                    botSecret: testBotSecret
                });
            expect(res.status).to.equal(200);
            const names = (res.body.rules || []).map(r => r.name);
            expect(names).to.include(probeName);
        });
    });
});

// ============================================
// Optimistic Locking Tests
// ============================================

describe('Optimistic Locking', () => {
    const testDeviceId = 'optimistic-test-' + Date.now();
    const testBotSecret = 'optimistic-secret';
    
    before(async () => {
        await pool.query('SELECT init_mission_dashboard($1)', [testDeviceId]);
    });
    
    after(async () => {
        await pool.query('DELETE FROM mission_dashboard WHERE device_id = $1', [testDeviceId]);
    });
    
    it('should detect version conflict when uploading', async () => {
        // First upload
        await request(app)
            .post('/api/mission/dashboard')
            .send({
                deviceId: testDeviceId,
                entityId: 1,
                botSecret: testBotSecret,
                dashboard: { todoList: [], missionList: [], doneList: [], notes: [], rules: [] },
                version: 1
            });
        
        // Another client updates (simulated by manually updating version)
        await pool.query(
            'UPDATE mission_dashboard SET version = version + 1 WHERE device_id = $1',
            [testDeviceId]
        );
        
        // First client tries to upload with old version
        const res = await request(app)
            .post('/api/mission/dashboard')
            .send({
                deviceId: testDeviceId,
                entityId: 1,
                botSecret: testBotSecret,
                dashboard: { todoList: [{ title: 'Late update' }], missionList: [], doneList: [], notes: [], rules: [] },
                version: 1 // Old version
            });
        
        expect(res.status).to.equal(409);
        expect(res.body.error).to.equal('VERSION_CONFLICT');
    });
});

// ============================================
// Version Control Tests
// ============================================

describe('Version Control', () => {
    const testDeviceId = 'version-test-' + Date.now();
    const testBotSecret = 'version-secret';
    
    before(async () => {
        await pool.query('SELECT init_mission_dashboard($1)', [testDeviceId]);
    });
    
    after(async () => {
        await pool.query('DELETE FROM mission_dashboard WHERE device_id = $1', [testDeviceId]);
    });
    
    it('should auto-increment version on update', async () => {
        // Initial version
        let res = await request(app)
            .get('/api/mission/dashboard')
            .query({ deviceId: testDeviceId, entityId: 1, botSecret: testBotSecret });
        
        const initialVersion = res.body.dashboard.version;
        
        // Upload
        res = await request(app)
            .post('/api/mission/dashboard')
            .send({
                deviceId: testDeviceId,
                entityId: 1,
                botSecret: testBotSecret,
                dashboard: { todoList: [{ title: 'V1' }], missionList: [], doneList: [], notes: [], rules: [] },
                version: initialVersion
            });
        
        expect(res.body.version).to.equal(initialVersion + 1);
        
        // Verify
        res = await request(app)
            .get('/api/mission/dashboard')
            .query({ deviceId: testDeviceId, entityId: 1, botSecret: testBotSecret });
        
        expect(res.body.dashboard.version).to.equal(initialVersion + 1);
    });
});
