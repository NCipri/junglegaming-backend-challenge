import { migrateDown, migrateUp } from '../src/infrastructure/db/migrator';

const [direction, steps] = process.argv.slice(2);
const url = process.env.DATABASE_MIGRATOR_URL;

if (!url) {
  throw new Error('DATABASE_MIGRATOR_URL is required');
}
if (direction === 'up') {
  await migrateUp(url);
} else if (direction === 'down') {
  await migrateDown(url, steps === undefined ? 1 : Number.parseInt(steps, 10));
} else {
  throw new Error('Usage: bun scripts/migrate.ts up | down [steps]');
}
console.log(`migrations ${direction} done`);
