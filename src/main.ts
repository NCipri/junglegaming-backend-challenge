// Process entry point: validates the environment and starts the roles listed in APP_ROLES.
import 'reflect-metadata';
import { loadConfig } from './config/config.schema';
import { createHttpApp } from './http-app';

const config = loadConfig(process.env);
const app = await createHttpApp({ config });

if (config.roles.includes('api')) {
  await app.listen(config.http.port);
} else {
  await app.init();
}
