// Lint enforces the hard rules in AGENTS.md. It is not a style checker.
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', '**/node_modules/**'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            // Both consumers speak LSP over stdout.
            'no-console': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
        },
    },
    {
        // Production code only; tests may spawn processes and use any.
        files: ['src/**/*.ts'],
        ignores: ['src/**/*.test.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: ['child_process', 'node:child_process'].map(name => ({
                    name, message: 'Only src/salesforce/cli.ts may launch processes.',
                })),
            }],
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        // The one sf launcher.
        files: ['src/salesforce/cli.ts'],
        rules: { 'no-restricted-imports': 'off' },
    },
);
