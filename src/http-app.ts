// Builds the HTTP application: correlation and JSON-only body middleware in front of the Nest module.
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { AppOptions } from './app.module.types';
import { correlationMiddleware } from './infrastructure/http/correlation';
import { jsonBodyMiddleware } from './infrastructure/http/json-body';
import { requestLogMiddleware } from './infrastructure/http/request-log';
import { NoopLogger } from './modules/observability/logger.port';
import { UuidV7Generator } from './shared/ids/id-generator';

export async function createHttpApp(options: AppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    bodyParser: false,
    logger: false,
  });

  app.disable('x-powered-by');
  const logger = options.logger ?? new NoopLogger();

  app.use(correlationMiddleware(new UuidV7Generator(), options.config.instanceId));
  app.use(requestLogMiddleware(logger));
  app.use(jsonBodyMiddleware(logger));
  app.enableShutdownHooks();

  return app;
}
