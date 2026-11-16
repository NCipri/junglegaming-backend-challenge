// Persistence record of the read-only providers table (seeded by migration).
import { EntitySchema } from '@mikro-orm/core';

export interface ProviderRecord {
  id: string;
  status: string;
  createdAt: Date;
}

export const ProviderRecordSchema = new EntitySchema<ProviderRecord>({
  name: 'ProviderRecord',
  tableName: 'providers',
  properties: {
    id: { type: 'text', primary: true },
    status: { type: 'text' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
