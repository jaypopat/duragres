-- Scripted psql demo: psql postgres://demo@localhost:8788/mydb -f test/fixtures/session.sql
\set ECHO queries
\set VERBOSITY verbose
\echo '=== who am I talking to?'
SELECT version();
SELECT current_database(), current_user;
\echo '=== demo corpus'
\i test/fixtures/demo.sql
\echo '=== meta-commands'
\dt
\d users
\d posts
\l
\echo '=== commit a transaction'
BEGIN;
UPDATE users SET name = 'Ada Lovelace' WHERE id = 1 RETURNING id, name;
COMMIT;
\echo '=== errors carry SQLSTATE codes'
INSERT INTO users (email, name) VALUES ('ada@example.com', 'dup');
INSERT INTO users (email) VALUES ('nobody@example.com');
SELECT * FROM missing_table;
