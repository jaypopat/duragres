import type { Env } from "./env";
import { config, DB_NAME } from "./database/lifecycle";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/forks") return new Response("Duragres\n", { status: url.pathname === "/" ? 200 : 404 });
  if (request.method !== "POST") return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
  if (!env.FORK_TOKEN || request.headers.get("authorization") !== `Bearer ${env.FORK_TOKEN}`) {
    return new Response("A fork token is required", { status: 401 });
  }

  const source = url.searchParams.get("source") ?? "";
  if (!DB_NAME.test(source)) return new Response("Invalid source database", { status: 400 });
  const name = `fork-${crypto.randomUUID()}`;
  const key = `forks/${name}.json`;
  const databaseUrl = new URL(env.POSTGRES_URL ?? "postgres://demo@localhost:8788/?sslmode=disable");
  databaseUrl.pathname = "/" + name;
  if (!(await env.PG.getByName(source).saveSnapshot(key))) {
    return new Response("Source database does not exist or has expired", { status: 404 });
  }
  try {
    if (!(await env.LIMITS.getByName("global").tryCreateDatabase(config(env).maxNewPerHour))) {
      return new Response("Database creation limit reached", { status: 429 });
    }
    await env.PG.getByName(name).loadSnapshot(key);
    return Response.json({ name, databaseUrl: databaseUrl.href }, { status: 201 });
  } finally {
    await env.SNAPSHOTS.delete(key);
  }
}
