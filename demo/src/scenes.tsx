import type { ReactNode } from "react";
import { AbsoluteFill, Easing, Img, interpolate, interpolateColors, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Block, BlockLabel, GAP } from "./Block";
import type { Slab } from "./Block";
import { C, MARGIN, MONO, SANS, sec } from "./theme";

export type Props = { host: string };

// ---- Shared pieces ----

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = (t: number) => Easing.inOut((x) => Easing.cubic(x))(t);

function useSpringAt(at: number, damping = 200) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping } });
}

/** How much of `text` is typed by now, starting at `from`, one character per `rate` frames. */
function typed(text: string, frame: number, from: number, rate = 1.1) {
  return text.slice(0, Math.max(0, Math.floor((frame - from) / rate)));
}

type Beat = { at: number; title: string; sub?: string };

/** The scene's headline: one sentence that changes with the beat. */
const Headline = ({ beats }: { beats: Array<Beat> }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: MARGIN, top: 104, right: MARGIN }}>
      {beats.map((beat, i) => {
        const next = beats[i + 1]?.at;
        const fadeIn = beat.at === 0 ? 1 : interpolate(frame, [beat.at, beat.at + 7], [0, 1], clamp);
        const fadeOut = next === undefined ? 1 : interpolate(frame, [next - 5, next - 1], [1, 0], clamp);
        const opacity = Math.min(fadeIn, fadeOut);
        if (opacity <= 0) return null;
        return (
          <div key={beat.at} style={{ position: "absolute", inset: 0, opacity, transform: `translateY(${(1 - fadeIn) * 10}px)` }}>
            <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 68, lineHeight: 1.08, letterSpacing: -1.6, color: C.ink }}>{beat.title}</div>
            {beat.sub ? <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 30, lineHeight: 1.35, color: C.slate, marginTop: 16, maxWidth: 1300 }}>{beat.sub}</div> : null}
          </div>
        );
      })}
    </div>
  );
};

const Cursor = ({ on }: { on: boolean }) => {
  const frame = useCurrentFrame();
  return <span style={{ display: "inline-block", width: "0.55ch", height: "1.05em", marginLeft: 2, verticalAlign: "-0.15em", background: C.ink, opacity: on && Math.floor(frame / 16) % 2 === 0 ? 0.85 : 0 }} />;
};

/** The one line being typed in a scene, at the fixed spot under the headline. */
const Line = ({ children, size = 42 }: { children: ReactNode; size?: number }) => (
  <div style={{ position: "absolute", left: MARGIN, top: 330, fontFamily: MONO, fontSize: size, lineHeight: 1.2, color: C.blue, whiteSpace: "pre" }}>{children}</div>
);

const Footnote = () => (
  <div style={{ position: "absolute", left: MARGIN, bottom: 52, fontFamily: SANS, fontWeight: 500, fontSize: 22, color: C.slate }}>
    Running locally on Miniflare.
  </div>
);

// ---- Any name is a database ----

const NAMES = ["shop", "pr-1337", "agent-7", "staging", "ci-run-88", "preview-42", "eval-3", "sandbox", "tenant-9"];
// Where each block ends up: five across, then four between them. "shop" takes the middle of the first row.
const CELLS: Array<{ x: number; y: number }> = [
  { x: 960, y: 690 }, { x: 300, y: 690 }, { x: 630, y: 690 }, { x: 1290, y: 690 }, { x: 1620, y: 690 },
  { x: 465, y: 920 }, { x: 795, y: 920 }, { x: 1125, y: 920 }, { x: 1455, y: 920 },
];
// Before the others arrive, "shop" lands alone and large.
const SHOP_ALONE = { x: 960, y: 900, size: 250, slab: 120 };
const BLOCK = { size: 140, slab: 64 };
const FIRST_ENTER = 82;
const NEXT_AT = 150;
const NEXT_EVERY = 19;

export const ANY_NAME_FRAMES = 340;

export const AnyName = ({ host }: Props) => {
  const frame = useCurrentFrame();
  const prefix = `postgres://${host}/`;
  const full = `${prefix}${NAMES[0]}`;

  // Which name the URL shows, how much of it is typed, and when each one is entered.
  const enters = NAMES.map((_, k) => (k === 0 ? FIRST_ENTER : NEXT_AT + (k - 1) * NEXT_EVERY + 10));
  const current = Math.max(0, enters.findLastIndex((at, k) => frame >= (k === 0 ? 0 : at - 10)));
  const urlTyped = current === 0 ? typed(full, frame, 26) : `${prefix}${typed(NAMES[current], frame, enters[current] - 10, 1)}`;
  const shownPrefix = urlTyped.slice(0, prefix.length);
  const shownName = urlTyped.slice(prefix.length);
  const entered = frame >= enters[current];

  // The first name leaves the URL and lands as its block.
  const flight = ease(interpolate(frame, [FIRST_ENTER + 2, FIRST_ENTER + 26], [0, 1], clamp));

  return (
    <AbsoluteFill>
      <Headline
        beats={[
          { at: 0, title: "psql, straight into a Durable Object.", sub: "Over raw TCP, now that Workers accept inbound connections." },
          { at: 112, title: "Connect to a name, and that database exists.", sub: "The Worker reads the name from the connection and hands the socket to that object." },
          { at: 214, title: "Every database is its own Durable Object.", sub: "With its own SQLite storage. Deleted after 72 hours unless someone claims it." },
        ]}
      />
      <Line>
        <span style={{ color: C.slate }}>psql </span>
        {shownPrefix}
        <span style={{ color: C.orange, opacity: current === 0 && flight > 0 ? 0 : 1 }}>{shownName}</span>
        <Cursor on={!entered || current > 0} />
      </Line>
      {entered ? (
        <div style={{ position: "absolute", left: MARGIN, top: 404, fontFamily: MONO, fontSize: 22, color: C.slate }}>
          {`created database "${NAMES[current]}"`}
        </div>
      ) : null}

      {NAMES.map((name, k) => {
        const landAt = k === 0 ? FIRST_ENTER + 18 : enters[k] + 2;
        return <SpawnedBlock key={name} name={name} cell={CELLS[k]} at={landAt} alone={k === 0} />;
      })}

      {/* The flying name: from its place in the URL to its label under the block. */}
      {flight > 0 && flight < 1 ? (
        <div
          style={{
            position: "absolute", fontFamily: MONO, fontSize: 42, lineHeight: 1.2, whiteSpace: "pre",
            color: interpolateColors(flight, [0.6, 1], [C.orange, C.ink]),
            left: `calc((${MARGIN}px + ${"psql ".length + prefix.length}ch) * ${1 - flight} + (${SHOP_ALONE.x}px - ${NAMES[0].length * 0.33}ch) * ${flight})`,
            top: interpolate(flight, [0, 1], [330, SHOP_ALONE.y + 16]),
            transform: `scale(${1 - flight * 0.35})`, transformOrigin: "left top",
          }}
        >
          {NAMES[0]}
        </div>
      ) : null}
      <Footnote />
    </AbsoluteFill>
  );
};

const SpawnedBlock = ({ name, cell, at, alone }: { name: string; cell: { x: number; y: number }; at: number; alone: boolean }) => {
  const land = useSpringAt(at, 13);
  const frame = useCurrentFrame();
  // "shop" moves from its solo spot into the field just before the others start arriving.
  const settle = alone ? ease(interpolate(frame, [NEXT_AT - 22, NEXT_AT + 2], [0, 1], clamp)) : 1;
  if (frame < at) return null;
  const from = alone ? SHOP_ALONE : { ...cell, ...BLOCK };
  const x = interpolate(settle, [0, 1], [from.x, cell.x]);
  const y = interpolate(settle, [0, 1], [from.y, cell.y]);
  const size = interpolate(settle, [0, 1], [alone ? SHOP_ALONE.size : BLOCK.size, BLOCK.size]);
  const slab = interpolate(settle, [0, 1], [alone ? SHOP_ALONE.slab : BLOCK.slab, BLOCK.slab]);
  return (
    <>
      <Block x={x} y={y} size={size} slabs={[{ height: slab }]} drop={(1 - land) * 160} opacity={Math.min(1, land * 2)} />
      <BlockLabel x={x} y={y} name={name} size={alone ? interpolate(settle, [0, 1], [28, 22]) : 22} opacity={interpolate(frame, [at + 4, at + 10], [0, 1], clamp)} />
    </>
  );
};

// ---- Branching ----

const SHOP = { x: 700, y: 900 };
const COPY = { x: 1280, y: 900 };
const BIG = 270;
const SLAB = 74;
const ENTER = { create: 62, dropTable: 168, dropDb: 292 };
export const BRANCH_FRAMES = 350;

const LINES = [
  { from: 10, enter: ENTER.create, prompt: "shop=# ", sql: `CREATE DATABASE "pr-42" TEMPLATE "shop";` },
  { from: 132, enter: ENTER.dropTable, prompt: "pr-42=# ", sql: "DROP TABLE orders;" },
  { from: 256, enter: ENTER.dropDb, prompt: "shop=# ", sql: `DROP DATABASE "pr-42";` },
];

/** Two tables as two slabs; `knocked` (0..1) knocks the top one off. */
const tables = (knocked: number): Array<Slab> => [
  { height: SLAB },
  {
    height: SLAB,
    tone: knocked > 0.05 ? "red" : "orange",
    lift: knocked * 70,
    tilt: knocked * 14,
    opacity: 1 - interpolate(knocked, [0.55, 1], [0, 1], clamp),
  },
];

export const Branching = () => {
  const frame = useCurrentFrame();
  const cloned = ease(interpolate(frame, [ENTER.create + 2, ENTER.create + 34], [0, 1], clamp));
  const knock = interpolate(frame, [ENTER.dropTable + 2, ENTER.dropTable + 40], [0, 1], clamp);
  const gone = ease(interpolate(frame, [ENTER.dropDb + 2, ENTER.dropDb + 26], [0, 1], clamp));
  const intact = useSpringAt(ENTER.dropTable + 50, 14);
  const line = LINES.findLast((l) => frame >= l.from) ?? LINES[0];
  const copyX = interpolate(cloned, [0, 1], [SHOP.x, COPY.x]);

  return (
    <AbsoluteFill>
      <Headline
        beats={[
          { at: 0, title: "Branch a database with one statement.", sub: "The copy is a new Durable Object with the same tables and rows." },
          { at: 126, title: "Break the copy. The original doesn't notice." },
          { at: 250, title: "Drop it when you're done." },
        ]}
      />
      <Line>
        <span style={{ color: C.slate }}>{line.prompt}</span>
        {typed(line.sql, frame, line.from, 1)}
        <Cursor on={frame < line.enter + 6} />
      </Line>

      <TableNames x={SHOP.x} y={SHOP.y} />
      <Block x={SHOP.x} y={SHOP.y} size={BIG} slabs={tables(0)} />
      <BlockLabel x={SHOP.x} y={SHOP.y} name="shop" size={26} />
      <div style={{ position: "absolute", left: SHOP.x - 150, width: 300, top: SHOP.y + 64, textAlign: "center", fontFamily: SANS, fontWeight: 600, fontSize: 24, color: C.green, opacity: intact }}>
        unchanged
      </div>

      {cloned > 0 ? (
        <>
          <Block x={copyX} y={COPY.y} size={BIG} slabs={tables(knock)} opacity={interpolate(cloned, [0, 0.3], [0.3, 1], clamp) * (1 - gone)} squash={gone * 0.9} />
          <BlockLabel x={copyX} y={COPY.y} name="pr-42" size={26} opacity={cloned * (1 - gone)} />
        </>
      ) : null}
    </AbsoluteFill>
  );
};

/** Names the original's two slabs, level with each slab's left face. */
const TableNames = ({ x, y }: { x: number; y: number }) => (
  <>
    {["users", "orders"].map((name, i) => (
      <div key={name} style={{ position: "absolute", left: x - BIG / 2 - 260, width: 236, top: y - BIG / 4 - i * (SLAB + GAP) - SLAB / 2 - 16, textAlign: "right", fontFamily: SANS, fontWeight: 500, fontSize: 26, color: C.slate }}>
        {name} table
      </div>
    ))}
  </>
);

// ---- Your tools work ----

export const TOOLS_FRAMES = 270;

const CODE: Array<Array<[string, string]>> = [
  [["const ", C.slate], ["db", C.ink], [" = ", C.slate], ["drizzle", C.blue], ["(process.env.DATABASE_URL);", C.ink]],
  [["const ", C.slate], ["[user]", C.ink], [" = await ", C.slate], ["db.insert", C.blue], ["(users)", C.ink]],
  [["  .values", C.blue], [`({ name: "Ada", email: "ada@x.dev", prefs: { theme: "dark" } })`, C.ink]],
  [["  .returning", C.blue], ["();", C.ink]],
];

const RESULTS = [
  { field: "user.active", value: "true", type: "boolean" },
  { field: "user.createdAt", value: "2026-11-23T20:41:16.765Z", type: "Date" },
  { field: "user.prefs", value: `{ theme: "dark" }`, type: "object" },
];

export const Tools = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Headline beats={[{ at: 0, title: "Your Postgres tools already work.", sub: "Drizzle over node-postgres, given a Duragres URL. No adapter, and real types come back." }]} />
      <div style={{ position: "absolute", left: MARGIN, right: MARGIN, top: 320, padding: "30px 36px", background: C.paper, borderRadius: 10, border: `1px solid ${C.rule}` }}>
        {CODE.map((parts, i) => (
          <div key={parts.map(([t]) => t).join("")} style={{ fontFamily: MONO, fontSize: 25, lineHeight: 1.75, whiteSpace: "pre", opacity: interpolate(frame, [12 + i * 6, 20 + i * 6], [0, 1], clamp) }}>
            {parts.map(([text, color]) => <span key={text} style={{ color }}>{text}</span>)}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: MARGIN, right: MARGIN, top: 690 }}>
        {RESULTS.map((r, i) => {
          const show = interpolate(frame, [70 + i * 22, 80 + i * 22], [0, 1], clamp);
          return (
            <div key={r.field} style={{ display: "flex", alignItems: "baseline", height: 72, paddingTop: 16, borderTop: `1px solid ${C.rule}`, opacity: show }}>
              <div style={{ width: 420, fontFamily: MONO, fontSize: 26, color: C.slate }}>{r.field}</div>
              <div style={{ flex: 1, fontFamily: MONO, fontSize: 26, color: C.ink }}>{r.value}</div>
              <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 36, color: C.blue }}>{r.type}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ---- Meme ----

export const MEME_FRAMES = sec(3.4);
const MEME = { width: 680, height: 383 };

export const Meme = () => {
  const frame = useCurrentFrame();
  const pop = useSpringAt(0, 14);
  const label = useSpringAt(10, 12);
  const scale = 1500 / MEME.width;
  const px = (n: number) => n * scale;
  const drift = interpolate(frame, [0, MEME_FRAMES], [1, 1.04]);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: px(MEME.width), height: px(MEME.height), borderRadius: 14, overflow: "hidden", transform: `scale(${(0.95 + 0.05 * pop) * drift})`, opacity: pop }}>
        <Img src={staticFile("meme.png")} style={{ width: "100%", height: "100%" }} />
        {/* Cover the template's "?", then finish the sentence in the template's own type. */}
        <div style={{ position: "absolute", left: px(417), top: px(139), width: px(20), height: px(24), background: "#000" }} />
        <div
          style={{
            position: "absolute", left: px(350), top: px(137), fontFamily: "Liberation Sans, Arial, sans-serif", fontSize: px(18), lineHeight: 1.2,
            color: C.orange, whiteSpace: "nowrap", opacity: label, transform: `scale(${0.8 + 0.2 * label})`, transformOrigin: "left center",
            textShadow: "0 0 2px #000",
          }}
        >
          Durable Objects<span style={{ color: "#fff" }}>?</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- End ----

export const END_FRAMES = sec(5);

export const End = ({ host }: Props) => {
  const frame = useCurrentFrame();
  const word = useSpringAt(0);
  const rest = useSpringAt(12);
  const names = ["anything", "pr-1337", "agent-run-42"];
  const k = Math.min(names.length - 1, Math.floor(Math.max(0, frame - 24) / 32));
  const name = typed(names[k], frame, 24 + k * 32, 1.2);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: MARGIN, top: 290 }}>
        <div style={{ position: "relative", height: 160, opacity: word, transform: `translateY(${(1 - word) * 16}px)` }}>
          <Block x={60} y={150} size={104} slabs={[{ height: 36 }, { height: 36 }]} />
          <div style={{ position: "absolute", left: 150, top: 0, fontFamily: SANS, fontWeight: 800, fontSize: 150, letterSpacing: -6, color: C.ink, lineHeight: 1 }}>Duragres</div>
        </div>
        <div style={{ opacity: rest, transform: `translateY(${(1 - rest) * 12}px)` }}>
          <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 46, letterSpacing: -0.8, color: C.ink, marginTop: 24 }}>
            Instant, branchable Postgres for agents and previews.
          </div>
          <div style={{ fontFamily: MONO, fontSize: 36, color: C.blue, marginTop: 56, whiteSpace: "pre" }}>
            <span style={{ color: C.slate }}>psql </span>postgres://{host}/<span style={{ color: C.orange }}>{name}</span>
            <Cursor on />
          </div>
        </div>
      </div>
      <Footnote />
    </AbsoluteFill>
  );
};
