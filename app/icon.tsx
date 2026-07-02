import { ImageResponse } from "next/og";
import { readFileSync } from "fs";
import { join } from "path";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

function oklchToHex(L: number, C: number, H: number): string {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  const rLin =  4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const gLin = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bLin = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_;

  const toSrgb = (c: number) => {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };

  const R = Math.round(toSrgb(rLin) * 255);
  const G = Math.round(toSrgb(gLin) * 255);
  const B = Math.round(toSrgb(bLin) * 255);
  return `#${R.toString(16).padStart(2, "0")}${G.toString(16).padStart(2, "0")}${B.toString(16).padStart(2, "0")}`;
}

function readTheme() {
  const cssPath = join(process.cwd(), "app/globals.css");
  const css = readFileSync(cssPath, "utf-8");

  const extract = (re: RegExp, token: string): string => {
    const value = css.match(re)?.[1];
    if (value === undefined) {
      throw new Error(
        `app/icon.tsx readTheme(): could not parse ${token} from ${cssPath}. ` +
        `The favicon derives its colors from globals.css; if that variable was ` +
        `renamed or reformatted, update the matching regex here so the icon stays in sync.`
      );
    }
    return value;
  };

  const num = /(\d*\.?\d+)/.source;
  const hue = parseFloat(extract(new RegExp(`--nh-accent-hue\\s*:\\s*${num}`), "--nh-accent-hue"));
  const L   = parseFloat(extract(new RegExp(`--nh-accent\\s*:\\s*oklch\\(\\s*${num}`), "the L number of --nh-accent: oklch(L C ...)"));
  const Cv  = parseFloat(extract(new RegExp(`--nh-accent\\s*:\\s*oklch\\(\\s*\\d*\\.?\\d+\\s+${num}`), "the C number of --nh-accent: oklch(L C ...)"));
  const bg  = extract(/--nh-bg\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/, "--nh-bg hex color");

  return { accent: oklchToHex(L, Cv, hue), bg };
}

export default function Icon() {
  const { accent, bg } = readTheme();

  return new ImageResponse(
    (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: "100%", height: "100%",
        background: bg,
      }}>
        <span style={{ fontSize: 44, fontWeight: 700, color: "#ffffff", lineHeight: 1 }}>n</span>
        <span style={{ fontSize: 44, fontWeight: 700, color: accent, lineHeight: 1 }}>d</span>
      </div>
    ),
    { ...size }
  );
}
