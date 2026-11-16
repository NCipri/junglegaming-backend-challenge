// Seeds the active game providers; their ids match the Keycloak client ids (D-003).
import { Migration } from '@mikro-orm/migrations';

export class Migration20261115000004_seed_providers extends Migration {
  override up(): void {
    this.addSql(
      `INSERT INTO providers (id, status) VALUES ('provider-a', 'ACTIVE'), ('provider-b', 'ACTIVE');`,
    );
  }

  override down(): void {
    this.addSql(`DELETE FROM providers WHERE id IN ('provider-a', 'provider-b');`);
  }
}
