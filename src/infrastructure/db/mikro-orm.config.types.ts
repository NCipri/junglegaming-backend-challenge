// Options of the runtime MikroORM connection.
export interface AppOrmOptions {
  clientUrl: string;
  poolSize: number;
  connectTimeoutMs: number;
  acquireTimeoutMs: number;
  queryTimeoutMs: number;
  onQuery?: (sql: string) => void;
}
