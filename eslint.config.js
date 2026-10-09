// SPDX-License-Identifier: GPL-3.0-or-later
// Based on the rules GNOME Shell uses for its own code (lint/eslintrc-gjs.yml).

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['musicbar@jgproduction.com/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.es2024,
                global: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        plugins: {'@stylistic': stylistic},
        rules: {
            'array-callback-return': 'error',
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'eqeqeq': ['error', 'always', {null: 'ignore'}],
            'no-empty': ['error', {allowEmptyCatch: true}],
            'no-implicit-coercion': ['error', {allow: ['!!']}],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'no-useless-return': 'error',
            'no-var': 'error',
            'object-shorthand': 'error',
            'prefer-arrow-callback': 'error',
            'prefer-const': 'error',
            'prefer-template': 'error',

            '@stylistic/array-bracket-spacing': 'error',
            '@stylistic/arrow-parens': ['error', 'as-needed'],
            '@stylistic/block-spacing': 'error',
            '@stylistic/brace-style': 'error',
            '@stylistic/comma-dangle': ['error', 'always-multiline'],
            '@stylistic/comma-spacing': 'error',
            '@stylistic/eol-last': 'error',
            '@stylistic/indent': ['error', 4, {
                SwitchCase: 0,
                CallExpression: {arguments: 1},
                FunctionExpression: {parameters: 1},
                ArrayExpression: 1,
                ObjectExpression: 1,
                MemberExpression: 'off',
                ignoredNodes: [
                    'CallExpression[callee.object.name=GObject][callee.property.name=registerClass] > ClassExpression:first-child',
                ],
            }],
            '@stylistic/key-spacing': 'error',
            '@stylistic/keyword-spacing': 'error',
            '@stylistic/no-multi-spaces': 'error',
            '@stylistic/no-multiple-empty-lines': ['error', {max: 1}],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/object-curly-spacing': 'error',
            '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
            '@stylistic/semi': 'error',
            '@stylistic/space-before-blocks': 'error',
            '@stylistic/space-before-function-paren': ['error', {named: 'never', anonymous: 'always', asyncArrow: 'always'}],
            '@stylistic/space-infix-ops': 'error',
        },
    },
];
