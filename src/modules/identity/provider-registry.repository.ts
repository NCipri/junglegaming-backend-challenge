// Provider registry: reads a provider and whether it is active (D-003).
import type { EntityManager } from '@mikro-orm/postgresql';
import type { ProviderInfo } from './provider-registry.types';

export class ProviderRegistry {
  constructor(private readonly em: EntityManager) {}

  async find(id: string): Promise<ProviderInfo | null> {
    const rows = await this.em.execute<{ id: string; status: string }[]>(
      'SELECT id, status FROM providers WHERE id = ?',
      [id],
    );
    const row = rows[0];

    return row ? { id: row.id, active: row.status === 'ACTIVE' } : null;
  }
}
