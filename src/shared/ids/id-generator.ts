// Id generator port; production ids are time-ordered UUIDv7.
export interface IdGenerator {
  next(): string;
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
