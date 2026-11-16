-- Postgres bootstrap: application roles and databases (dev credentials only).
-- migrator owns the schema and runs migrations; app is the least-privilege runtime role (D-012).
CREATE ROLE migrator WITH LOGIN PASSWORD 'migrator';
CREATE ROLE app WITH LOGIN PASSWORD 'app';
CREATE ROLE keycloak WITH LOGIN PASSWORD 'keycloak';

CREATE DATABASE wagering OWNER migrator;
CREATE DATABASE keycloak OWNER keycloak;

REVOKE ALL ON DATABASE wagering FROM PUBLIC;
GRANT CONNECT ON DATABASE wagering TO migrator, app;

\connect wagering
-- Only migrator may create objects; app gets usage only. Table privileges come from migrations.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app;
