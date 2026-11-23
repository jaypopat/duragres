// Forks the database in DATABASE_URL and prints the fork's URL.
const source = new URL(process.env.DATABASE_URL!);
const endpoint = new URL("/forks", process.env.DURAGRES_HTTP_URL ?? "http://localhost:8787");
endpoint.searchParams.set("source", source.pathname.slice(1));
const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${process.env.FORK_TOKEN}` } });
if (!response.ok) throw new Error(await response.text());
const { name } = (await response.json()) as { name: string };
source.pathname = `/${name}`;
console.log(source.href);
