-- Demo corpus: one statement per block, separated by ";" at end of line.
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  uid UUID DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN DEFAULT false,
  profile JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_posts_user ON posts (user_id);
INSERT INTO users (email, name, profile) VALUES ('ada@example.com', 'Ada Lovelace', '{"city": "London", "lang": "en"}') RETURNING *;
INSERT INTO users (email, name, active, profile) VALUES ('alan@example.com', 'Alan Turing', true, '{"city": "Manchester", "lang": "en"}') RETURNING id, email;
INSERT INTO users (email, name, active, profile) VALUES ('grace@example.com', 'Grace Hopper', true, '{"city": "New York", "lang": "en"}'), ('linus@example.com', 'Linus Torvalds', false, '{"city": "Portland", "lang": "fi"}');
INSERT INTO users (email, name, active) VALUES ('ada@example.com', 'Ada King', true) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active RETURNING id, name, active;
INSERT INTO posts (user_id, title, views) VALUES (1, 'Notes on the Analytical Engine', 120), (1, 'Bernoulli numbers', 45), (2, 'Computing Machinery and Intelligence', 300), (3, 'COBOL tips', 80);
SELECT id, email, name FROM users WHERE active = true ORDER BY id;
SELECT name FROM users WHERE name ILIKE '%ada%';
SELECT id, title, views FROM posts ORDER BY views DESC LIMIT 2;
SELECT COUNT(*) FROM users;
SELECT active, COUNT(*) AS n FROM users GROUP BY active ORDER BY active;
SELECT u.name, COUNT(p.id) AS posts, SUM(p.views) AS total_views FROM users u LEFT JOIN posts p ON p.user_id = u.id GROUP BY u.name ORDER BY total_views DESC;
SELECT id::text AS id_text, '42'::int + 1 AS answer FROM users ORDER BY id LIMIT 1;
SELECT name, profile ->> 'city' AS city FROM users WHERE profile ->> 'lang' = 'en' ORDER BY name;
SELECT COUNT(*) AS recent FROM users WHERE created_at > now() - interval '1 day';
SELECT length(uid::text) AS uuid_len FROM users ORDER BY id LIMIT 1;
UPDATE posts SET views = views + 1 WHERE user_id = 1 RETURNING id, views;
UPDATE users SET active = NOT active WHERE email = 'linus@example.com' RETURNING name, active;
DELETE FROM posts WHERE views < 50;
SELECT COUNT(*) AS remaining_posts FROM posts;
DROP TABLE IF EXISTS scratch;
CREATE TABLE scratch (k TEXT PRIMARY KEY, v JSONB);
DROP TABLE scratch;
