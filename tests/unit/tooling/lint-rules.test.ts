// Verifies the project's ESLint guard rails: no number for money, pure domain layer.
import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// Fixtures are linted as virtual files, so type-aware linting is disabled here;
// every rule under test is syntactic and comes from the real eslint.config.js.
const eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

const moneyFile = 'src/shared/money/fixture.ts';
const domainFile = 'src/modules/wallet/domain/fixture.ts';

describe('money guard rails', () => {
  test('forbids parseFloat', async () => {
    expect(await ruleIds('export const v = parseFloat("1.5");\n', moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  test('forbids Number(...) conversion', async () => {
    expect(await ruleIds('export const v = (a: string) => Number(a);\n', moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  test('forbids .toNumber()', async () => {
    expect(
      await ruleIds('export const v = (d: { toNumber(): unknown }) => d.toNumber();\n', moneyFile),
    ).toContain('no-restricted-syntax');
  });

  test('forbids unary plus conversion', async () => {
    expect(await ruleIds('export const v = (a: string) => +a;\n', moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  test('forbids number-typed amount, balance and money properties', async () => {
    for (const prop of ['amount', 'balance', 'balanceAfter', 'money']) {
      expect(await ruleIds(`export type T = { ${prop}: number };\n`, moneyFile)).toContain(
        'no-restricted-syntax',
      );
    }
  });
});

describe('domain purity', () => {
  test('forbids importing NestJS in the domain layer', async () => {
    expect(await ruleIds(`import '@nestjs/common';\n`, domainFile)).toContain(
      'no-restricted-imports',
    );
  });

  test('forbids importing MikroORM in the domain layer', async () => {
    expect(await ruleIds(`import '@mikro-orm/core';\n`, domainFile)).toContain(
      'no-restricted-imports',
    );
  });

  test('allows NestJS outside the domain layer', async () => {
    expect(await ruleIds(`import '@nestjs/common';\n`, 'src/config/fixture.ts')).not.toContain(
      'no-restricted-imports',
    );
  });
});

test('a clean file has no findings', async () => {
  const clean = 'export const total = (a: string, b: string): string => `${a}${b}`;\n';
  expect(await ruleIds(clean, moneyFile)).toEqual([]);
});
