/**
 * Hand-drawn-looking strokes for tests (fork ia-local, fase 5): shapes drawn
 * in one stroke with some wobble, arrows, and short "letter" strokes.
 */
import { newFreeDrawElement } from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type {
  ExcalidrawFreeDrawElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

type XY = [number, number];

/** deterministic wobble */
const noise = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
};

let counter = 0;

export const strokeFrom = (
  points: XY[],
  id = `stroke-${++counter}`,
): NonDeleted<ExcalidrawFreeDrawElement> => {
  const minX = Math.min(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1]));
  const maxX = Math.max(...points.map((p) => p[0]));
  const maxY = Math.max(...points.map((p) => p[1]));
  const [x0, y0] = points[0];
  return {
    ...newFreeDrawElement({
      type: "freedraw",
      x: x0,
      y: y0,
      simulatePressure: true,
      points: points.map(([x, y]) => pointFrom<LocalPoint>(x - x0, y - y0)),
    }),
    id,
    width: maxX - minX,
    height: maxY - minY,
  };
};

const along = (
  from: XY,
  to: XY,
  steps: number,
  wobble: () => number,
  amount: number,
) =>
  Array.from({ length: steps }, (_, i): XY => {
    const t = i / steps;
    return [
      from[0] + (to[0] - from[0]) * t + wobble() * amount,
      from[1] + (to[1] - from[1]) * t + wobble() * amount,
    ];
  });

export const rectangleStroke = (
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
) => {
  const wobble = noise(seed);
  const corners: XY[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];
  const points: XY[] = [];
  for (let i = 0; i < 4; i++) {
    points.push(...along(corners[i], corners[i + 1], 16, wobble, 3));
  }
  points.push([x + 4, y + 2]);
  return strokeFrom(points);
};

export const diamondStroke = (
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 2,
) => {
  const wobble = noise(seed);
  const corners: XY[] = [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
    [x + w / 2, y],
  ];
  const points: XY[] = [];
  for (let i = 0; i < 4; i++) {
    points.push(...along(corners[i], corners[i + 1], 16, wobble, 3));
  }
  points.push([x + w / 2 + 3, y + 2]);
  return strokeFrom(points);
};

export const ellipseStroke = (
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 3,
) => {
  const wobble = noise(seed);
  const points: XY[] = Array.from({ length: 64 }, (_, i): XY => {
    const angle = (i / 60) * Math.PI * 2;
    return [
      x + w / 2 + (w / 2) * Math.cos(angle) + wobble() * 3,
      y + h / 2 + (h / 2) * Math.sin(angle) + wobble() * 3,
    ];
  });
  return strokeFrom(points);
};

/** a straight stroke, no head */
export const lineStroke = (from: XY, to: XY, seed = 4) =>
  strokeFrom([...along(from, to, 30, noise(seed), 2), to]);

/** a small "V" at `tip`, opening back towards `from` */
export const arrowheadStroke = (from: XY, tip: XY, size = 18) => {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const wing = (side: number): XY => [
    tip[0] - size * Math.cos(angle + side * 0.5),
    tip[1] - size * Math.sin(angle + side * 0.5),
  ];
  const left = wing(1);
  const right = wing(-1);
  return strokeFrom([
    left,
    [(left[0] + tip[0]) / 2, (left[1] + tip[1]) / 2],
    tip,
    [(right[0] + tip[0]) / 2, (right[1] + tip[1]) / 2],
    right,
  ]);
};

/** a "word": one short squiggle per letter, letters side by side */
export const inkWord = (
  x: number,
  y: number,
  letters: number,
  height = 20,
  seed = 5,
) => {
  const wobble = noise(seed);
  return Array.from({ length: letters }, (_, i) => {
    const left = x + i * height * 0.7;
    return strokeFrom(
      Array.from(
        { length: 10 },
        (_, k): XY => [
          left + (k / 9) * height * 0.5 + wobble() * 2,
          y + (k % 2 ? height : height * 0.3) + wobble() * 2,
        ],
      ),
    );
  });
};
