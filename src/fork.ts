// POST /forks?source=<name>: copies a database into a new one through an R2 snapshot.
import { DB_NAME } from "./database/lifecycle";

export async function fetch(request: Request, env: Env): Promise<Response> {
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
  try {
    if (!(await env.PG.getByName(source).saveSnapshot(key))) {
      return new Response("Source database does not exist or has expired", { status: 404 });
    }
    await env.PG.getByName(name).loadSnapshot(key);
    return Response.json({ name }, { status: 201 });
  } finally {
    await env.SNAPSHOTS.delete(key);
  }
}
