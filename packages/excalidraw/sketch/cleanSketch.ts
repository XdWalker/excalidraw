/**
 * "Limpar rascunho" (fork ia-local, fase 5): turns hand-drawn strokes into a
 * clean diagram. Shapes and arrows come from Excalidraw's own shape
 * recognizer (one stroke per shape); handwriting is grouped into words/lines
 * here and read by the host (e.g. a local vision LLM); this module never
 * talks to any AI itself.
 */
import { convertToShape, recognizeShape } from "@excalidraw/element";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawFrameLikeElement,
  ExcalidrawFreeDrawElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import type { AppState } from "../types";

type Point = { x: number; y: number };
type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Stroke = NonDeleted<ExcalidrawFreeDrawElement>;

export type SketchShape = {
  id: string;
  type: "rectangle" | "ellipse" | "diamond";
  box: Box;
  strokeIds: string[];
};

export type SketchConnector = {
  id: string;
  start: Point;
  end: Point;
  /** has an arrowhead at `end` */
  arrow: boolean;
  startShapeId: string | null;
  endShapeId: string | null;
  strokeIds: string[];
};

export type SketchInk = {
  id: string;
  box: Box;
  strokes: Stroke[];
  target:
    | { kind: "shape"; id: string }
    | { kind: "connector"; id: string }
    | { kind: "free" };
};

export type SketchAnalysis = {
  shapes: SketchShape[];
  connectors: SketchConnector[];
  inks: SketchInk[];
};

export const SKETCH = {
  /** smaller closed strokes are letters (an "o"), not shapes */
  shapeMinSize: 60,
  /** shorter open strokes are letters (an "l"), not lines */
  connectorMinLength: 50,
  /** a short stroke this close to a line's end is its arrowhead */
  arrowheadMaxSize: 45,
  arrowheadMaxDistance: 30,
  /** how far a connector's end may be from a shape and still attach */
  attachDistance: 40,
  /** how far a word may be from a connector and still be its label */
  labelDistance: 60,
};

const boxOf = (points: readonly Point[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});

const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

const sizeOf = (box: Box) => Math.max(box.maxX - box.minX, box.maxY - box.minY);

const centerOf = (box: Box): Point => ({
  x: (box.minX + box.maxX) / 2,
  y: (box.minY + box.maxY) / 2,
});

const distanceToBox = (p: Point, box: Box) =>
  Math.hypot(
    Math.max(box.minX - p.x, 0, p.x - box.maxX),
    Math.max(box.minY - p.y, 0, p.y - box.maxY),
  );

const inside = (p: Point, box: Box) =>
  p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;

const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy || 1;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** the stroke's points in scene coordinates (rotation included) */
export const strokeScenePoints = (stroke: Stroke): GlobalPoint[] => {
  const center = pointFrom<GlobalPoint>(
    stroke.x + stroke.width / 2,
    stroke.y + stroke.height / 2,
  );
  return stroke.points.map(([x, y]) => {
    const point = pointFrom<GlobalPoint>(stroke.x + x, stroke.y + y);
    return stroke.angle
      ? pointRotateRads(point, center, stroke.angle as Radians)
      : point;
  });
};

const toPoints = (points: readonly GlobalPoint[]): Point[] =>
  points.map(([x, y]) => ({ x, y }));

/**
 * Classifies every stroke as a shape, a connector or ink (handwriting), finds
 * arrowheads drawn as separate strokes, attaches connectors to the shapes at
 * their ends, groups ink into words/lines and decides where each group's text
 * goes (inside a shape, on a connector, or free).
 */
export const analyzeSketch = (
  strokes: readonly Stroke[],
  appState: AppState,
  elementsMap: ElementsMap,
  frames: readonly ExcalidrawFrameLikeElement[] = [],
): SketchAnalysis => {
  const shapes: SketchShape[] = [];
  const connectors: SketchConnector[] = [];
  let ink: { stroke: Stroke; box: Box }[] = [];

  for (const stroke of strokes) {
    const scenePoints = strokeScenePoints(stroke);
    if (scenePoints.length < 3) {
      ink.push({ stroke, box: boxOf(toPoints(scenePoints)) });
      continue;
    }
    const box = boxOf(toPoints(scenePoints));
    const { type } = recognizeShape(scenePoints, null, 1);

    if (
      (type === "rectangle" || type === "ellipse" || type === "diamond") &&
      sizeOf(box) >= SKETCH.shapeMinSize
    ) {
      shapes.push({
        id: `shape-${stroke.id}`,
        type,
        box,
        strokeIds: [stroke.id],
      });
      continue;
    }

    if (type === "arrow" || type === "line") {
      // the converter knows which end an arrowhead is on
      const converted = convertToShape(
        scenePoints,
        appState,
        elementsMap,
        null,
        frames,
      );
      if (
        converted &&
        (converted.type === "arrow" || converted.type === "line") &&
        converted.points.length >= 2
      ) {
        const first = converted.points[0];
        const last = converted.points[converted.points.length - 1];
        const start = { x: converted.x + first[0], y: converted.y + first[1] };
        const end = { x: converted.x + last[0], y: converted.y + last[1] };
        if (
          Math.hypot(end.x - start.x, end.y - start.y) >=
          SKETCH.connectorMinLength
        ) {
          connectors.push({
            id: `connector-${stroke.id}`,
            start,
            end,
            arrow: converted.type === "arrow",
            startShapeId: null,
            endShapeId: null,
            strokeIds: [stroke.id],
          });
          continue;
        }
      }
    }

    ink.push({ stroke, box });
  }

  // arrowheads drawn as separate small strokes: they make a line an arrow
  // pointing to the end they're at
  for (const connector of connectors) {
    for (const item of [...ink]) {
      if (sizeOf(item.box) > SKETCH.arrowheadMaxSize) {
        continue;
      }
      const distanceToEnd = distanceToBox(connector.end, item.box);
      const distanceToStart = distanceToBox(connector.start, item.box);
      const nearest = Math.min(distanceToEnd, distanceToStart);
      if (nearest > SKETCH.arrowheadMaxDistance) {
        continue;
      }
      if (distanceToStart < distanceToEnd && !connector.arrow) {
        // the head is at the start: flip so the arrow points there
        [connector.start, connector.end] = [connector.end, connector.start];
      }
      connector.arrow = true;
      connector.strokeIds.push(item.stroke.id);
      ink = ink.filter((other) => other !== item);
    }
  }

  // attach connector ends to the nearest shape
  const shapeNear = (point: Point, exclude: string | null) => {
    let best: SketchShape | null = null;
    let bestDistance = SKETCH.attachDistance;
    for (const shape of shapes) {
      if (shape.id === exclude) {
        continue;
      }
      const distance = distanceToBox(point, shape.box);
      if (distance <= bestDistance) {
        best = shape;
        bestDistance = distance;
      }
    }
    return best;
  };
  for (const connector of connectors) {
    connector.startShapeId = shapeNear(connector.start, null)?.id ?? null;
    connector.endShapeId =
      shapeNear(connector.end, connector.startShapeId)?.id ?? null;
  }

  // where each ink stroke's text goes: inside a shape (its label), next to a
  // connector (its label) or free. Everything going to the same shape or
  // connector is read as one image, however the letters are spaced (an "i"
  // dot, a gap between letters); free ink is grouped by proximity.
  const targetOf = (box: Box): SketchInk["target"] => {
    const center = centerOf(box);
    const container = shapes
      .filter((shape) => inside(center, shape.box))
      .sort(
        (a, b) =>
          (a.box.maxX - a.box.minX) * (a.box.maxY - a.box.minY) -
          (b.box.maxX - b.box.minX) * (b.box.maxY - b.box.minY),
      )[0];
    if (container) {
      return { kind: "shape", id: container.id };
    }
    let nearest: SketchConnector | null = null;
    let nearestDistance = SKETCH.labelDistance;
    for (const connector of connectors) {
      const distance = distanceToSegment(
        center,
        connector.start,
        connector.end,
      );
      if (distance < nearestDistance) {
        nearest = connector;
        nearestDistance = distance;
      }
    }
    return nearest ? { kind: "connector", id: nearest.id } : { kind: "free" };
  };

  type Group = { strokes: Stroke[]; box: Box; target: SketchInk["target"] };
  const byTarget = new Map<string, Group>();
  const free: { stroke: Stroke; box: Box }[] = [];
  for (const item of ink) {
    const target = targetOf(item.box);
    if (target.kind === "free") {
      free.push(item);
      continue;
    }
    const key = `${target.kind}:${target.id}`;
    const group = byTarget.get(key);
    if (group) {
      group.strokes.push(item.stroke);
      group.box = unionBox(group.box, item.box);
    } else {
      byTarget.set(key, { strokes: [item.stroke], box: item.box, target });
    }
  }

  const heights = ink
    .map((item) => item.box.maxY - item.box.minY)
    .sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 20;
  // letters/words on the same line can be about a letter and a half apart
  const gapX = Math.max(16, typicalHeight * 1.5);
  const gapY = Math.max(8, typicalHeight * 0.5);
  const near = (a: Box, b: Box) =>
    a.minX - gapX <= b.maxX &&
    b.minX - gapX <= a.maxX &&
    a.minY - gapY <= b.maxY &&
    b.minY - gapY <= a.maxY;

  // free ink touching a label (e.g. the last letter of an arrow's label,
  // a bit too far from the arrow) belongs to that label
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of [...free]) {
      const group = [...byTarget.values()].find((candidate) =>
        near(candidate.box, item.box),
      );
      if (group) {
        group.strokes.push(item.stroke);
        group.box = unionBox(group.box, item.box);
        free.splice(free.indexOf(item), 1);
        changed = true;
      }
    }
  }

  // the rest: strokes close to each other form a free text
  const parent = free.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (near(free[i].box, free[j].box)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const freeGroups = new Map<number, Group>();
  free.forEach((item, i) => {
    const root = find(i);
    const group = freeGroups.get(root);
    if (group) {
      group.strokes.push(item.stroke);
      group.box = unionBox(group.box, item.box);
    } else {
      freeGroups.set(root, {
        strokes: [item.stroke],
        box: item.box,
        target: { kind: "free" },
      });
    }
  });

  const inks: SketchInk[] = [...byTarget.values(), ...freeGroups.values()]
    .sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX)
    .map((group, index) => ({ id: `ink-${index}`, ...group }));

  return { shapes, connectors, inks };
};

/** a font about as big as the handwriting (its height includes ascenders) */
const fontSizeFor = (inkHeight: number) =>
  Math.round(Math.min(Math.max(inkHeight * 0.8, 16), 36));

/**
 * Skeletons for the clean diagram. `texts` holds what was read from each ink
 * group (by id); groups without a text aren't converted (their strokes stay).
 */
export const buildCleanSkeletons = (
  analysis: SketchAnalysis,
  texts: ReadonlyMap<string, string | null>,
): ExcalidrawElementSkeleton[] => {
  /** the text read for a shape/connector, sized like the handwriting */
  const labelFor = (kind: "shape" | "connector", id: string) => {
    const groups = analysis.inks.filter(
      (inkGroup) =>
        inkGroup.target.kind === kind &&
        "id" in inkGroup.target &&
        inkGroup.target.id === id &&
        texts.get(inkGroup.id)?.trim(),
    );
    if (!groups.length) {
      return null;
    }
    const text = groups
      .map((inkGroup) => texts.get(inkGroup.id)!.trim())
      .join("\n");
    const lines = text.split("\n").length;
    const inkHeight = groups.reduce(
      (sum, inkGroup) => sum + (inkGroup.box.maxY - inkGroup.box.minY),
      0,
    );
    return { text, fontSize: fontSizeFor(inkHeight / lines) };
  };

  const skeletons: ExcalidrawElementSkeleton[] = [];

  for (const shape of analysis.shapes) {
    const label = labelFor("shape", shape.id);
    skeletons.push({
      type: shape.type,
      id: shape.id,
      x: shape.box.minX,
      y: shape.box.minY,
      width: shape.box.maxX - shape.box.minX,
      height: shape.box.maxY - shape.box.minY,
      ...(label ? { label } : {}),
    });
  }

  for (const connector of analysis.connectors) {
    const label = labelFor("connector", connector.id);
    skeletons.push({
      type: "arrow",
      id: connector.id,
      x: connector.start.x,
      y: connector.start.y,
      points: [
        pointFrom<LocalPoint>(0, 0),
        pointFrom<LocalPoint>(
          connector.end.x - connector.start.x,
          connector.end.y - connector.start.y,
        ),
      ],
      startArrowhead: null,
      endArrowhead: connector.arrow ? "arrow" : null,
      ...(connector.startShapeId
        ? { start: { id: connector.startShapeId } }
        : {}),
      ...(connector.endShapeId ? { end: { id: connector.endShapeId } } : {}),
      ...(label ? { label } : {}),
    });
  }

  for (const inkGroup of analysis.inks) {
    const text = texts.get(inkGroup.id)?.trim();
    if (inkGroup.target.kind !== "free" || !text) {
      continue;
    }
    const height = inkGroup.box.maxY - inkGroup.box.minY;
    skeletons.push({
      type: "text",
      x: inkGroup.box.minX,
      y: inkGroup.box.minY,
      text,
      fontSize: fontSizeFor(height),
    });
  }

  return skeletons;
};

/** strokes that the clean diagram replaces */
export const consumedStrokeIds = (
  analysis: SketchAnalysis,
  texts: ReadonlyMap<string, string | null>,
) =>
  new Set([
    ...analysis.shapes.flatMap((shape) => shape.strokeIds),
    ...analysis.connectors.flatMap((connector) => connector.strokeIds),
    ...analysis.inks
      .filter((inkGroup) => texts.get(inkGroup.id)?.trim())
      .flatMap((inkGroup) => inkGroup.strokes.map((stroke) => stroke.id)),
  ]);
