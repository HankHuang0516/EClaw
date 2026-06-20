'use strict';

// DEFAULT_DIM is provider-driven (openai=1536, voyage=1024, local=384). The
// schema-normalization assertions derive the expected dimension from the module
// rather than hard-coding 1536, so the suite stays correct under any provider.
const { DEFAULT_DIM } = require('../../embedding-client');
const EXPECTED_TYPE = `vector(${DEFAULT_DIM})`;
const LEGACY_DIM = DEFAULT_DIM + 1; // any dim that differs from the active one
const WRONG_DIM = DEFAULT_DIM === 1024 ? 1536 : 1024; // a dim != DEFAULT_DIM

function createPool(columnType = EXPECTED_TYPE) {
    const pool = {
        queries: [],
        async query(sql) {
            const text = String(sql);
            pool.queries.push(text);
            if (text.includes('pg_catalog.format_type')) {
                return { rows: [{ column_type: columnType }] };
            }
            return { rows: [] };
        },
        // HNSW index build runs on a dedicated client (SET max_parallel_maintenance_workers=0
        // applies to the same session). Route the client's queries into the same recorder so
        // ordering assertions still see the CREATE INDEX.
        async connect() {
            return {
                query: (sql) => pool.query(sql),
                release: () => {},
            };
        },
    };
    return pool;
}

function queryIndex(pool, needle) {
    return pool.queries.findIndex((sql) => sql.includes(needle));
}

describe('chat-embedding schema normalization', () => {
    let warnSpy;

    beforeEach(() => {
        jest.resetModules();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        jest.dontMock('../../embedding-client');
    });

    it('repairs a legacy unbounded pgvector column before creating the HNSW index', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool('vector');

        await chatEmbedding.initSchema(pool);

        expect(queryIndex(pool, 'DROP INDEX IF EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
        expect(queryIndex(pool, `vector_dims(embedding) <> ${DEFAULT_DIM}`)).toBeGreaterThan(-1);
        expect(queryIndex(pool, `ALTER COLUMN embedding TYPE ${EXPECTED_TYPE}`)).toBeGreaterThan(-1);
        expect(queryIndex(pool, `ALTER COLUMN embedding TYPE ${EXPECTED_TYPE}`))
            .toBeLessThan(queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw'));
    });

    it('repairs a legacy fixed-dimension vector column before creating the HNSW index', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool(`vector(${LEGACY_DIM})`);

        await chatEmbedding.initSchema(pool);

        expect(queryIndex(pool, 'DROP INDEX IF EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
        expect(queryIndex(pool, `vector_dims(embedding) <> ${DEFAULT_DIM}`)).toBeGreaterThan(-1);
        expect(queryIndex(pool, `ALTER COLUMN embedding TYPE ${EXPECTED_TYPE}`)).toBeGreaterThan(-1);
        expect(queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
    });

    it('does not rewrite an already correctly dimensioned vector column', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool(EXPECTED_TYPE);

        await chatEmbedding.initSchema(pool);

        expect(queryIndex(pool, 'DROP INDEX IF EXISTS idx_chat_embedding_hnsw')).toBe(-1);
        expect(queryIndex(pool, `ALTER COLUMN embedding TYPE ${EXPECTED_TYPE}`)).toBe(-1);
        expect(queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
    });

    it('builds the HNSW index single-threaded to avoid /dev/shm exhaustion', async () => {
        // Parallel index build allocates a ~60MB DSM segment in the container's /dev/shm,
        // which fails on hosted PG (Railway ~64MB): "could not resize shared memory segment
        // ... No space left on device". The build must SET max_parallel_maintenance_workers=0
        // on the same connection BEFORE CREATE INDEX. (card_cff46d3 HNSW fix)
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool(EXPECTED_TYPE);

        await chatEmbedding.initSchema(pool);

        const setIdx = queryIndex(pool, 'SET max_parallel_maintenance_workers = 0');
        const createIdx = queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw');
        expect(setIdx).toBeGreaterThan(-1);
        expect(createIdx).toBeGreaterThan(-1);
        expect(setIdx).toBeLessThan(createIdx);
    });
});

describe('chat-embedding dimension guards', () => {
    let warnSpy;

    beforeEach(() => {
        jest.resetModules();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        jest.dontMock('../../embedding-client');
    });

    it('skips semantic search when the query vector has the wrong dimension', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool();
        await chatEmbedding.initSchema(pool);
        const queryCount = pool.queries.length;

        const rows = await chatEmbedding.searchBySemantic('device-a', Array(WRONG_DIM).fill(0.1));

        expect(rows).toEqual([]);
        expect(pool.queries).toHaveLength(queryCount);
    });

    it('skips embedding writes when the generated vector has the wrong dimension', async () => {
        jest.doMock('../../embedding-client', () => ({
            DEFAULT_DIM,
            generateEmbedding: jest.fn().mockResolvedValue(Array(WRONG_DIM).fill(0.1)),
            toPgVectorLiteral: jest.fn(() => '[0.100000]'),
        }));
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool();
        await chatEmbedding.initSchema(pool);
        const queryCount = pool.queries.length;

        chatEmbedding.embedMessageAsync('message-1', 'hello');
        await new Promise((resolve) => setImmediate(resolve));

        expect(pool.queries).toHaveLength(queryCount);
    });
});
