import { C, MONO } from "./theme";

// A database drawn as an isometric block. Each table is a slab; slabs stack from the ground up.
export type Slab = {
  height: number;
  tone?: "orange" | "red";
  lift?: number; // px the slab has risen off the one below (it's being knocked off)
  tilt?: number; // degrees
  opacity?: number;
};

const TONES = {
  orange: { top: C.orangeTop, left: C.orange, right: C.orangeSide },
  red: { top: C.redTop, left: C.red, right: C.redSide },
};

const PAD = 80;
/** Space between stacked slabs, so each table reads as its own layer. */
export const GAP = 8;

/**
 * (x, y) is the block's front corner on the ground, in frame pixels. `size` is its width.
 * `drop` lifts the whole block off the ground (0 = landed), for its entrance.
 */
export const Block = ({ x, y, size, slabs, drop = 0, opacity = 1, squash = 0 }: {
  x: number; y: number; size: number; slabs: Array<Slab>; drop?: number; opacity?: number; squash?: number;
}) => {
  const a = size / 2;
  const total = slabs.reduce((h, s) => h + s.height + GAP, 0);
  const w = size + PAD * 2;
  const h = total + a + PAD * 2 + 200;
  // SVG origin: the ground front corner sits at (ox, oy).
  const ox = a + PAD;
  const oy = h - PAD;
  const elevations = slabs.map((_, i) => slabs.slice(0, i).reduce((sum, s) => sum + s.height + GAP, 0));
  return (
    <svg width={w} height={h} style={{ position: "absolute", left: x - ox, top: y - oy, overflow: "visible", opacity }}>
      <ellipse cx={ox} cy={oy - a / 2} rx={a * 1.05} ry={a * 0.55} fill="rgba(21,23,28,0.10)" style={{ filter: "blur(10px)" }} opacity={1 - Math.min(1, drop / 200)} />
      <g transform={`translate(0 ${-drop}) translate(${ox} ${oy}) scale(1 ${1 - squash}) translate(${-ox} ${-oy})`}>
        {slabs.map((slab, i) => <SlabShape key={elevations[i]} ox={ox} oy={oy} a={a} elevation={elevations[i] ?? 0} slab={slab} />)}
      </g>
    </svg>
  );
};

const SlabShape = ({ ox, oy, a, elevation, slab }: { ox: number; oy: number; a: number; elevation: number; slab: Slab }) => {
  const tone = TONES[slab.tone ?? "orange"];
  const e = elevation + (slab.lift ?? 0);
  const h = slab.height;
  const p = (dx: number, dy: number) => `${ox + dx},${oy + dy}`;
  const left = [p(-a, -e - a / 2), p(0, -e), p(0, -e - h), p(-a, -e - h - a / 2)].join(" ");
  const right = [p(0, -e), p(a, -e - a / 2), p(a, -e - h - a / 2), p(0, -e - h)].join(" ");
  const top = [p(0, -e - h), p(a, -e - h - a / 2), p(0, -e - h - a), p(-a, -e - h - a / 2)].join(" ");
  const cx = ox;
  const cy = oy - e - h / 2 - a / 2;
  return (
    <g opacity={slab.opacity ?? 1} transform={`rotate(${slab.tilt ?? 0} ${cx} ${cy})`}>
      <polygon points={left} fill={tone.left} />
      <polygon points={right} fill={tone.right} />
      <polygon points={top} fill={tone.top} />
      <polyline points={[p(-a, -e - h - a / 2), p(0, -e - h), p(a, -e - h - a / 2)].join(" ")} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} />
    </g>
  );
};

/** A database name under a block, in the same mono the URL is typed in. */
export const BlockLabel = ({ x, y, name, opacity = 1, size = 22 }: { x: number; y: number; name: string; opacity?: number; size?: number }) => (
  <div style={{ position: "absolute", left: x - 200, top: y + 18, width: 400, textAlign: "center", fontFamily: MONO, fontSize: size, lineHeight: 1.2, color: C.ink, opacity }}>
    {name}
  </div>
);
