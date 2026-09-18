const js = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'public/**',
            'test/**',
            'tests/**',
            'stress-test.js',
            'test*.js',
            'run_all_tests.js',
        ],
    },
    {
        ...js.configs.recommended,
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                setImmediate: 'readonly',
                clearImmediate: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                fetch: 'readonly',
                AbortSignal: 'readonly',
                AbortController: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                Blob: 'readonly',
                FormData: 'readonly',
                Headers: 'readonly',
                Request: 'readonly',
                Response: 'readonly',
                structuredClone: 'readonly',
            },
        },
        rules: {
            // argsIgnorePattern: params starting with _ are OK
            // caughtErrors: 'none' — catch(err/e/_) are always OK (never flag unused catch params)
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-console': 'off',
        },
    },
];
