import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

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

describe('code layout', () => {
  const file = 'src/shared/fixture.ts';

  test('requires braces on every if', async () => {
    const code = 'export function f(a: boolean): number {\n  if (a) return 1;\n\n  return 2;\n}\n';

    expect(await ruleIds(code, file)).toContain('curly');
  });

  test('requires a blank line after variable declarations', async () => {
    const code =
      'export function f(a: number): number {\n  const b = a * 2;\n  if (b > 2) {\n    return b;\n  }\n\n  return a;\n}\n';

    expect(await ruleIds(code, file)).toContain('@stylistic/padding-line-between-statements');
  });

  test('requires a blank line before return', async () => {
    const code =
      'export function f(a: number): number {\n  if (a > 2) {\n    return a;\n  }\n  return 0;\n}\n';

    expect(await ruleIds(code, file)).toContain('@stylistic/padding-line-between-statements');
  });

  test('accepts the expected layout', async () => {
    const code =
      'export function f(a: number): number {\n  const b = a * 2;\n\n  if (b > 2) {\n    return b;\n  }\n\n  return a;\n}\n';

    expect(await ruleIds(code, file)).toEqual([]);
  });
});
