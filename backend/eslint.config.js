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
                URL: 'readonly',
                fetch: 'readonly',
                AbortSignal: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-console': 'off',
        },
    },
];
