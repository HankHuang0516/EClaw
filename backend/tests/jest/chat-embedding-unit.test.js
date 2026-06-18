function createPool(columnType = 'vector(1536)') {
    const pool = {
        queries: [],
        async query(sql) {
            const text = String(sql);
            pool.queries.push(text);
            if (text.includes('pg_catalog.format_type')) {
                return { rows: [{ column_type: columnType }] };
            }
            return { rows: [] };
        }
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

    it('repairs a legacy unbounded pgvector column before creating HNSW index', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool('vector');

        await chatEmbedding.initSchema(pool);

        expect(queryIndex(pool, 'DROP INDEX IF EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
        expect(queryIndex(pool, 'vector_dims(embedding) <> 1536')).toBeGreaterThan(-1);
        expect(queryIndex(pool, 'ALTER COLUMN embedding TYPE vector(1536)')).toBeGreaterThan(-1);
        expect(queryIndex(pool, 'ALTER COLUMN embedding TYPE vector(1536)'))
            .toBeLessThan(queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw'));
    });

    it('does not rewrite an already dimensioned vector(1536) column', async () => {
        const chatEmbedding = require('../../chat-embedding');
        const pool = createPool('vector(1536)');

        await chatEmbedding.initSchema(pool);

        expect(queryIndex(pool, 'DROP INDEX IF EXISTS idx_chat_embedding_hnsw')).toBe(-1);
        expect(queryIndex(pool, 'ALTER COLUMN embedding TYPE vector(1536)')).toBe(-1);
        expect(queryIndex(pool, 'CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw')).toBeGreaterThan(-1);
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

        const rows = await chatEmbedding.searchBySemantic('device-a', [0.1, 0.2, 0.3]);

        expect(rows).toEqual([]);
        expect(pool.queries).toHaveLength(queryCount);
    });

    it('skips embedding writes when the generated vector has the wrong dimension', async () => {
        jest.doMock('../../embedding-client', () => ({
            DEFAULT_DIM: 1536,
            generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
            toPgVectorLiteral: jest.fn(() => '[0.100000,0.200000,0.300000]')
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
