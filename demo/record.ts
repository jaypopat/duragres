// Renders the demo video, and with --gif records the README's GIF from a real psql session.
//
//   cd demo && bun install
//   bun record.ts                 # out/duragres.mp4
//   nix shell nixpkgs#vhs nixpkgs#chromium nixpkgs#postgresql_18 nixpkgs#ffmpeg -c bun record.ts --gif   # also docs/demo.gif
//
// SHOWN_HOST (default pg.duragres.dev) is the host in every URL in the video. The GIF connects to
// SERVER (default localhost:8788) and shows that address, since README readers copy it. Against
// localhost the script starts its own `wrangler dev` on fresh storage.
import { $ } from "bun";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOWN_HOST = process.env.SHOWN_HOST ?? "pg.duragres.dev";
const [SERVER_HOST = "localhost", SERVER_PORT = "8788"] = (process.env.SERVER ?? "localhost:8788").split(":");
const LOCAL = SERVER_HOST === "localhost";

const DEMO = import.meta.dir;
const ROOT = join(DEMO, "..");
const OUT = join(DEMO, "out");
await mkdir(OUT, { recursive: true });

const video = join(OUT, "duragres.mp4");
await $`bunx remotion render src/index.ts Demo ${video} --crf=16 --props=${JSON.stringify({ host: SHOWN_HOST })}`.cwd(DEMO);
console.log(video);

if (process.argv.includes("--gif")) console.log(await recordGif());

// ---- README GIF: a real psql session, recorded with VHS ----

async function recordGif() {
  for (const tool of ["vhs", "psql", "ffmpeg"]) {
    if (!Bun.which(tool)) throw new Error(`${tool} is not on PATH; see the command at the top of demo/record.ts`);
  }
  const work = await mkdtemp(join(tmpdir(), "duragres-demo-"));

  // VHS's string parsing eats backslashes, so the shell setup lives in a file the shell sources.
  // A plain string, not String.raw: Bun's transpiler leaves "❯" there as ❯, which bash reads as \u (the user name).
  const rc = join(work, "rc.sh");
  await Bun.write(rc, [
    `PS1='\\[\\e[38;2;243;128;32m\\]❯\\[\\e[0m\\] '`,
    "export PSQLRC=/dev/null PAGER=cat",
    "",
  ].join("\n"));

  const clip = join(work, "psql.mp4");
  const type = (text: string, ms: number) => `Type@${ms}ms ${quote(text)}`;
  const theme = { name: "duragres", background: "#121215", foreground: "#e8e6e3", cursor: "#F38020", black: "#1d1d21", brightBlack: "#6b6b74", red: "#ff6b6b", green: "#8ee39c", yellow: "#f6c177", blue: "#7aa8ff", magenta: "#d4a4ff", cyan: "#7fd8d0", white: "#e8e6e3", brightWhite: "#ffffff" };
  const tape = [
    `Output ${quote(clip)}`,
    `Set Shell "bash"`,
    `Set FontFamily "JetBrains Mono"`,
    "Set FontSize 24",
    "Set Width 1240",
    "Set Height 600",
    "Set Padding 14", // 81 columns at 1240px: room for the 80-column create NOTICE
    "Set CursorBlink false",
    `Set Theme ${JSON.stringify(theme)}`,
    "Hide", `Type ${quote(`source ${rc}`)}`, "Enter", "Sleep 300ms", "Ctrl+L", "Sleep 300ms", "Show",
    "Sleep 300ms",
    type(`psql postgres://demo@${SERVER_HOST}${SERVER_PORT === "5432" ? "" : `:${SERVER_PORT}`}/shop`, 32), "Enter", "Sleep 3200ms",
    type("CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);", 18), "Enter", "Sleep 500ms",
    type("INSERT INTO users (name) VALUES ('Ada'), ('Linus');", 20), "Enter", "Sleep 500ms",
    type("SELECT * FROM users;", 30), "Enter", "Sleep 2200ms",
  ].join("\n");

  let dev: Bun.Subprocess | undefined;
  if (LOCAL) {
    if (await canConnect()) throw new Error(`something is already listening on ${SERVER_PORT}; stop it so the GIF starts from empty storage`);
    dev = Bun.spawn(["bunx", "wrangler", "dev", "--experimental-new-config", "--persist-to", join(work, "state")], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + 60_000;
    while (!(await canConnect())) {
      if (Date.now() > deadline) throw new Error("wrangler dev did not start listening");
      await Bun.sleep(500);
    }
  }
  try {
    await Bun.write(join(work, "psql.tape"), tape);
    await $`vhs ${join(work, "psql.tape")}`.env({ ...process.env, VHS_NO_SANDBOX: "true" }).quiet();
  } finally {
    dev?.kill();
  }

  await mkdir(join(ROOT, "docs"), { recursive: true });
  const gif = join(ROOT, "docs", "demo.gif");
  const palette = "fps=15,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=sierra2_4a";
  await $`ffmpeg -y -v error -i ${clip} -filter_complex ${palette} -loop 0 ${gif}`;
  return gif;
}

async function canConnect() {
  try {
    const socket = await Bun.connect({ hostname: SERVER_HOST, port: Number(SERVER_PORT), socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function quote(s: string) {
  const q = ['"', "'", "`"].find((c) => !s.includes(c));
  if (!q) throw new Error(`can't quote for VHS: ${s}`);
  return q + s + q;
}
