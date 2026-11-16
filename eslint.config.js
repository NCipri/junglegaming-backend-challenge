import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const MONEY_PROPERTY = '/^(amount|balance\\w*|money)$/';
const NUMBER_FOR_MONEY = 'Money must never be a number. Use Money / decimal strings.';

export default tseslint.config(
  { ignores: ['node_modules/', 'docs/', 'dist/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='parseFloat']", message: NUMBER_FOR_MONEY },
        { selector: "CallExpression[callee.name='Number']", message: NUMBER_FOR_MONEY },
        { selector: "CallExpression[callee.property.name='toNumber']", message: NUMBER_FOR_MONEY },
        { selector: "UnaryExpression[operator='+']", message: NUMBER_FOR_MONEY },
        {
          selector: `TSPropertySignature[key.name=${MONEY_PROPERTY}] > TSTypeAnnotation > TSNumberKeyword`,
          message: NUMBER_FOR_MONEY,
        },
        {
          selector: `PropertyDefinition[key.name=${MONEY_PROPERTY}] > TSTypeAnnotation > TSNumberKeyword`,
          message: NUMBER_FOR_MONEY,
        },
        {
          selector: `Identifier[name=${MONEY_PROPERTY}] > TSTypeAnnotation > TSNumberKeyword`,
          message: NUMBER_FOR_MONEY,
        },
      ],
    },
  },
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*'],
              message: 'The domain layer must not depend on NestJS.',
            },
            {
              group: ['@mikro-orm/*'],
              message: 'The domain layer must not depend on MikroORM.',
            },
          ],
        },
      ],
    },
  },
  prettier,
  {
    files: ['**/*.{ts,js}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      curly: ['error', 'all'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
    },
  },
);
