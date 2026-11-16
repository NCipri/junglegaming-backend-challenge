// Ordered list of schema migrations, registered explicitly (no filesystem discovery under Bun).
import { Migration20261115000001_initial_schema } from './Migration20261115000001_initial_schema';
import { Migration20261115000002_triggers } from './Migration20261115000002_triggers';
import { Migration20261115000003_privileges } from './Migration20261115000003_privileges';
import { Migration20261115000004_seed_providers } from './Migration20261115000004_seed_providers';

export const migrationsList = [
  { name: 'Migration20261115000001_initial_schema', class: Migration20261115000001_initial_schema },
  { name: 'Migration20261115000002_triggers', class: Migration20261115000002_triggers },
  { name: 'Migration20261115000003_privileges', class: Migration20261115000003_privileges },
  { name: 'Migration20261115000004_seed_providers', class: Migration20261115000004_seed_providers },
];
