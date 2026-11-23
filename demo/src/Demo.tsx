import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type { FC } from "react";
import { ANY_NAME_FRAMES, AnyName, BRANCH_FRAMES, Branching, END_FRAMES, End, MEME_FRAMES, Meme, TOOLS_FRAMES, Tools } from "./scenes";
import type { Props } from "./scenes";
import { C } from "./theme";

const FADE = 10;

// [scene, frames, fade into the next one?]
const SCENES: Array<[FC<Props>, number, boolean]> = [
  [AnyName, ANY_NAME_FRAMES, true],
  [Branching, BRANCH_FRAMES, true],
  [Tools, TOOLS_FRAMES, false], // hard cut into the meme
  [Meme, MEME_FRAMES, true],
  [End, END_FRAMES, false],
];

export const DEMO_FRAMES = SCENES.reduce((total, [, frames, fades]) => total + frames - (fades ? FADE : 0), 0);

export const Demo = (props: Props) => (
  <AbsoluteFill style={{ background: C.fog }}>
    <TransitionSeries>
      {SCENES.flatMap(([Scene, frames, fades], i) => [
        <TransitionSeries.Sequence key={`s${i}`} durationInFrames={frames}>
          <Scene {...props} />
        </TransitionSeries.Sequence>,
        ...(fades ? [<TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />] : []),
      ])}
    </TransitionSeries>
  </AbsoluteFill>
);
