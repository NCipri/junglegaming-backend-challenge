import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const MONEY_PROPERTY = '/^(amount|balance\\w*|money)$/';
const NUMBER_FOR_MONEY = 'Money must never be a number (D-009). Use Money / decimal strings.';

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
              message: 'The domain layer must not depend on NestJS (D-008).',
            },
            {
              group: ['@mikro-orm/*'],
              message: 'The domain layer must not depend on MikroORM (D-008).',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
