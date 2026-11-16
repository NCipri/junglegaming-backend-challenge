// Persistence errors: optimistic version conflicts (B-5) and failures already classified as transient.
export class VersionConflictError extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
  ) {
    super(`Row ${rowId} of ${table} changed concurrently (version or status no longer matches)`);
    this.name = 'VersionConflictError';
  }
}

export class TransientPersistenceError extends Error {
  constructor(
    readonly reason: string,
    cause: unknown,
  ) {
    super(`Transient persistence failure: ${reason}`, { cause });
    this.name = 'TransientPersistenceError';
  }
}
