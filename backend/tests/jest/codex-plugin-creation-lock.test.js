require('./helpers/mock-setup');

const { withCreationLock } = require('../../codex-plugin-creation-lock');

const LOCK = 'SELECT pg_try_advisory_lock($1::bigint) AS acquired';
const UNLOCK = 'SELECT pg_advisory_unlock($1::bigint) AS unlocked';
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixtureClient() {
    const client = {
        query: jest.fn(async sql => sql === UNLOCK ? { rows: [{ unlocked: true }] } : { rows: [{ acquired: true }] }),
        release: jest.fn()
    };
    return { client, pool: { connect: jest.fn().mockResolvedValue(client), query: jest.fn() } };
}

// A shared PostgreSQL-session model, deliberately outside either module instance.
// pg-mem function stubs alone cannot model blocking/session ownership. This models
// contention while the tests separately assert the exact PostgreSQL advisory SQL.
function advisoryServer() {
    const held = new Map();
    const events = [];
    const bindings = new Map();
    const secondAttempt = deferred();
    let attempts = 0;
    const unlock = (key, client) => {
        if (held.get(key) !== client) return false;
        held.delete(key);
        return true;
    };
    function pool() {
        const clients = [];
        return {
            clients,
            query: jest.fn(async (sql, params) => {
                events.push({ kind: 'business-query', sql });
                if (sql.startsWith('SELECT')) return { rows: bindings.has(params[0]) ? [{ entity_id: bindings.get(params[0]) }] : [] };
                bindings.set(params[0], params[1]);
                return { rows: [] };
            }),
            connect: jest.fn(async () => {
                const client = {
                    query: jest.fn(async (sql, [key]) => {
                        events.push({ kind: 'session-query', sql, key, client });
                        if (sql === LOCK) {
                            if (++attempts === 2) secondAttempt.resolve();
                            if (held.has(key)) return { rows: [{ acquired: false }] };
                            held.set(key, client);
                            return { rows: [{ acquired: true }] };
                        }
                        if (sql === UNLOCK) return { rows: [{ unlocked: unlock(key, client) }] };
                        throw new Error('Unexpected session query');
                    }),
                    release: jest.fn(error => {
                        if (error) for (const [key, holder] of held) if (holder === client) unlock(key, client);
                    })
                };
                clients.push(client);
                return client;
            })
        };
    }
    return { pool, held, events, secondAttempt };
}

test('two independent instances serialize side effects and re-read persisted creation', async () => {
    let firstInstance, secondInstance;
    jest.isolateModules(() => { firstInstance = require('../../codex-plugin-creation-lock').withCreationLock; });
    jest.isolateModules(() => { secondInstance = require('../../codex-plugin-creation-lock').withCreationLock; });
    expect(firstInstance).not.toBe(secondInstance);
    const server = advisoryServer();
    const firstPool = server.pool(), secondPool = server.pool();
    const entered = deferred(), finish = deferred();
    let provisions = 0;
    const create = pool => async () => {
        const result = await pool.query('SELECT entity_id FROM fixture_bindings WHERE request_id=$1', ['same-request']);
        if (result.rows.length) return result.rows[0].entity_id;
        const entityId = ++provisions;
        entered.resolve();
        await finish.promise;
        await pool.query('INSERT INTO fixture_bindings (request_id,entity_id) VALUES ($1,$2)', ['same-request', entityId]);
        return entityId;
    };
    const first = firstInstance(firstPool, 'owner', create(firstPool));
    await entered.promise;
    const second = secondInstance(secondPool, 'owner', create(secondPool), { retryIntervalMs: 1 });
    await server.secondAttempt.promise;
    expect(secondPool.query).not.toHaveBeenCalled();
    expect(provisions).toBe(1);
    finish.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(provisions).toBe(1);
    expect(firstPool.clients[0].query.mock.calls[0]).toEqual(secondPool.clients[0].query.mock.calls[0]);
    for (const pool of [firstPool, secondPool]) {
        const client = pool.clients[0];
        const calls = client.query.mock.calls;
        const key = calls[0][1][0];
        expect(calls.slice(0, -1).every(([sql, params]) => sql === LOCK && params[0] === key)).toBe(true);
        expect(calls[calls.length - 1]).toEqual([UNLOCK, [key]]);
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledWith();
    }
    expect(server.held.size).toBe(0);
});

test('different owners can create concurrently and callbacks use pool queries outside the lock session', async () => {
    const server = advisoryServer();
    const pool = server.pool();
    const entered = deferred(), finish = deferred();
    const first = withCreationLock(pool, 'owner-one', async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const second = withCreationLock(pool, 'owner-two', async () => {
        await pool.query('SELECT entity_id FROM fixture_bindings WHERE request_id=$1', ['other-request']);
        return 'second-result';
    });
    try {
        expect(await second).toBe('second-result');
        expect(server.held.size).toBe(1);
        expect(pool.clients[0].query.mock.calls[0][1]).not.toEqual(pool.clients[1].query.mock.calls[0][1]);
        expect(pool.query).toHaveBeenCalledTimes(1);
    } finally { finish.resolve(); await first; }
    expect(server.held.size).toBe(0);
});

test('owner identifiers are hashed into a stable signed bigint parameter, never interpolated into SQL', async () => {
    const { client, pool } = fixtureClient();
    const owner = "owner'); SELECT secret FROM accounts; --";
    expect(await withCreationLock(pool, owner, async () => 42)).toBe(42);
    await withCreationLock(pool, owner, async () => {});
    const key = client.query.mock.calls[0][1][0];
    expect(key).toMatch(/^-?\d+$/);
    expect(BigInt(key)).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(key)).toBeLessThan(2n ** 63n);
    expect(client.query.mock.calls[2]).toEqual([LOCK, [key]]);
    expect(JSON.stringify(client.query.mock.calls)).not.toContain(owner);
});

test('callback failure unlocks and returns the healthy session while preserving its error', async () => {
    const { client, pool } = fixtureClient();
    const failure = new Error('Creation failed');
    await expect(withCreationLock(pool, 'owner', async () => { throw failure; })).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith(UNLOCK, expect.any(Array));
    expect(client.release).toHaveBeenCalledWith();
    expect(client.release).toHaveBeenCalledTimes(1);
});

test('a rejected lock acquisition skips the callback and discards the possibly locked session', async () => {
    const { client, pool } = fixtureClient();
    const failure = new Error('Lock response lost');
    client.query.mockRejectedValueOnce(failure);
    const fn = jest.fn();
    await expect(withCreationLock(pool, 'owner', fn)).rejects.toBe(failure);
    expect(fn).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(failure);
});

test('unlock failure discards the session and rejects a successful callback result', async () => {
    const { client, pool } = fixtureClient();
    const failure = new Error('Unlock response lost');
    client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockRejectedValueOnce(failure);
    await expect(withCreationLock(pool, 'owner', async () => 'created')).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(failure);
});

test('cleanup failure discards the session without masking the original callback error', async () => {
    const { client, pool } = fixtureClient();
    const creationError = new Error('Creation failed');
    const cleanupError = new Error('Unlock failed');
    client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockRejectedValueOnce(cleanupError);
    await expect(withCreationLock(pool, 'owner', async () => { throw creationError; })).rejects.toBe(creationError);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(cleanupError);
});

test('an unlock reporting false fails closed and discards the session', async () => {
    const { client, pool } = fixtureClient();
    client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    await expect(withCreationLock(pool, 'owner', async () => {})).rejects.toThrow('Creation advisory lock was not held');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
});

test('pool connection failure never invokes the callback', async () => {
    const { client, pool } = fixtureClient();
    const failure = new Error('Pool unavailable');
    pool.connect.mockRejectedValueOnce(failure);
    const fn = jest.fn();
    await expect(withCreationLock(pool, 'owner', fn)).rejects.toBe(failure);
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
});

test('a busy lock has a bounded wait, skips creation, and returns a healthy session', async () => {
    const { client, pool } = fixtureClient();
    client.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const fn = jest.fn();
    await expect(withCreationLock(pool, 'owner', fn, { timeoutMs: 0 })).rejects.toMatchObject({ status: 409, code: 'creation_busy' });
    expect(fn).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
});

test('a busy lock retries nonblocking SQL until it can acquire the session lock', async () => {
    const { client, pool } = fixtureClient();
    client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] }).mockResolvedValueOnce({ rows: [{ acquired: false }] });
    const fn = jest.fn().mockResolvedValue('created');
    expect(await withCreationLock(pool, 'owner', fn, { timeoutMs: 1000, retryIntervalMs: 1 })).toBe('created');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([LOCK, LOCK, LOCK, UNLOCK]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
});

test('an invalid acquisition response discards the session and skips creation', async () => {
    const { client, pool } = fixtureClient();
    client.query.mockResolvedValueOnce({ rows: [{}] });
    const fn = jest.fn();
    await expect(withCreationLock(pool, 'owner', fn)).rejects.toThrow('Invalid creation advisory lock response');
    expect(fn).not.toHaveBeenCalled();
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
});

test.each([null, '', 123])('invalid owner %p is rejected before checking out a connection', async owner => {
    const { pool } = fixtureClient();
    await expect(withCreationLock(pool, owner, async () => {})).rejects.toThrow(TypeError);
    expect(pool.connect).not.toHaveBeenCalled();
});

test('invalid pool or callback is rejected before acquisition', async () => {
    await expect(withCreationLock({}, 'owner', async () => {})).rejects.toThrow(TypeError);
    const { pool } = fixtureClient();
    await expect(withCreationLock(pool, 'owner', null)).rejects.toThrow(TypeError);
    expect(pool.connect).not.toHaveBeenCalled();
});

test.each([{ timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: 60001 }, { retryIntervalMs: 0 }, { retryIntervalMs: 1001 }])(
    'invalid wait options %p are rejected before acquisition', async options => {
        const { pool } = fixtureClient();
        await expect(withCreationLock(pool, 'owner', async () => {}, options)).rejects.toThrow(TypeError);
        expect(pool.connect).not.toHaveBeenCalled();
    });
