// Explicit column lists for hand-written SELECTs and strict parsing of raw timestamptz values.
export type ColumnMap<R> = { readonly [K in keyof R]-?: string };

export type SelectedRow<R> = {
  [K in keyof R]: R[K] extends Date
    ? string | Date
    : R[K] extends Date | null
      ? string | Date | null
      : R[K];
};

const PG_TIMESTAMPTZ =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2})(?::?(\d{2}))?$/;

export function selectList<R>(columns: ColumnMap<R>, alias?: string): string {
  const prefix = alias ? `${alias}.` : '';

  return Object.entries<string>(columns)
    .map(([property, column]) => `${prefix}${column} AS "${property}"`)
    .join(', ');
}

export function parseTimestamp(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(value);
  }
  const match = PG_TIMESTAMPTZ.exec(value);

  if (!match) {
    throw new Error(`Unexpected timestamptz value: ${value}`);
  }
  const [, date, time, fraction = '0', offsetHours, offsetMinutes = '00'] = match;
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  const parsed = new Date(`${date}T${time}.${millis}${offsetHours}:${offsetMinutes}`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unexpected timestamptz value: ${value}`);
  }

  return parsed;
}

export function parseNullableTimestamp(value: string | Date | null): Date | null {
  return value === null ? null : parseTimestamp(value);
}
