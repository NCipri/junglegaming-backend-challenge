import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const MINISTACK_IMAGE = 'ministackorg/ministack:1.5.41';

export interface TestPostgres {
  superuserUrl: string;
  migratorUrl: string;
  appUrl: string;
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

export interface TestSqs {
  endpoint: string;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export interface TestInfra {
  postgres: TestPostgres;
  sqs: TestSqs;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    .withCopyFilesToContainer([
      {
        source: resolve(import.meta.dir, '../../docker/postgres/init.sql'),
        target: '/docker-entrypoint-initdb.d/init.sql',
      },
    ])
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const url = (user: string, password: string) =>
    `postgresql://${user}:${password}@${host}:${port}/wagering`;

  return {
    superuserUrl: url('postgres', 'postgres'),
    migratorUrl: url('migrator', 'migrator'),
    appUrl: url('app', 'app'),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startSqs(): Promise<TestSqs> {
  const container = await new GenericContainer(MINISTACK_IMAGE)
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forHttp('/_ministack/health', 4566).forStatusCode(200))
    .start();

  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(4566)}`,
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startTestInfrastructure(): Promise<TestInfra> {
  const [postgres, sqs] = await Promise.all([startPostgres(), startSqs()]);

  return {
    postgres,
    sqs,
    stop: async () => {
      await Promise.all([postgres.stop(), sqs.stop()]);
    },
  };
}
