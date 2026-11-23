import { Composition } from "remotion";
import { DEMO_FRAMES, Demo } from "./Demo";
import type { Props } from "./scenes";
import { FPS, HEIGHT, WIDTH } from "./theme";

// The host shown in every URL. Rendering passes the real one with --props.
const defaultProps: Props = { host: "pg.duragres.dev" };

export const Root = () => (
  <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} defaultProps={defaultProps} />
);
