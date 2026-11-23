import { loadFont as loadMartian } from "@remotion/google-fonts/MartianMono";
import { loadFont as loadSchibsted } from "@remotion/google-fonts/SchibstedGrotesk";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const MARGIN = 120;

// Schibsted Grotesk says everything; Martian Mono is only for what someone types.
export const SANS = loadSchibsted("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"] }).fontFamily;
export const MONO = loadMartian("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

// Blue is the Postgres side (what the client types). Orange is only ever a Durable Object.
export const C = {
  fog: "#ECEEF1",
  ink: "#15171C",
  slate: "#5E6573",
  rule: "#CDD2D9",
  paper: "#FFFFFF",
  blue: "#2F5F8A",
  orange: "#F6821F",
  orangeTop: "#FFB36B",
  orangeSide: "#DB6A0C",
  red: "#E5484D",
  redTop: "#FF8A80",
  redSide: "#C2363B",
  green: "#2E8B57",
};

export const sec = (seconds: number) => Math.round(seconds * FPS);
