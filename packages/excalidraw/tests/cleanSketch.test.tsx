import { arrayToMap } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  recognizeShape,
  syncInvalidIndices,
} from "@excalidraw/element";

import { actionCleanSketch } from "../actions";
import { getDefaultAppState } from "../appState";
import { Excalidraw } from "../index";
import {
  analyzeSketch,
  buildCleanSkeletons,
  consumedStrokeIds,
  strokeScenePoints,
} from "../sketch/cleanSketch";

import {
  arrowheadStroke,
  diamondStroke,
  ellipseStroke,
  inkWord,
  lineStroke,
  rectangleStroke,
} from "./helpers/sketchStrokes";
import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, waitFor } from "./test-utils";

import type { AppState } from "../types";

const { h } = window;

const appState = {
  ...getDefaultAppState(),
  width: 1200,
  height: 800,
  offsetLeft: 0,
  offsetTop: 0,
} as AppState;

const analyze = (strokes: ReturnType<typeof rectangleStroke>[]) =>
  analyzeSketch(strokes, appState, arrayToMap(strokes));

describe("sketch strokes (test helpers)", () => {
  it("are recognized by Excalidraw's own recognizer", () => {
    const type = (stroke: ReturnType<typeof rectangleStroke>) =>
      recognizeShape(strokeScenePoints(stroke), null, 1).type;
    expect(type(rectangleStroke(0, 0, 200, 90))).toBe("rectangle");
    expect(type(ellipseStroke(0, 0, 180, 90))).toBe("ellipse");
    expect(type(diamondStroke(0, 0, 200, 140))).toBe("diamond");
    expect(type(lineStroke([0, 0], [0, 150]))).toBe("line");
  });
});

describe("analyzeSketch", () => {
  it("finds shapes, an arrow with a separate head, and where text goes", () => {
    const box = rectangleStroke(100, 100, 220, 90);
    const decision = diamondStroke(100, 300, 220, 140);
    const shaft = lineStroke([210, 195], [210, 295]);
    const head = arrowheadStroke([210, 195], [210, 295]);
    const wordInBox = inkWord(150, 130, 5);
    const wordByArrow = inkWord(230, 230, 3, 18, 9);
    const freeWord = inkWord(600, 600, 4, 22, 11);

    const analysis = analyze([
      box,
      decision,
      shaft,
      head,
      ...wordInBox,
      ...wordByArrow,
      ...freeWord,
    ]);

    expect(analysis.shapes.map((shape) => shape.type).sort()).toEqual([
      "diamond",
      "rectangle",
    ]);

    expect(analysis.connectors).toHaveLength(1);
    const [connector] = analysis.connectors;
    expect(connector.arrow).toBe(true);
    // points down: from the box to the decision
    expect(connector.end.y).toBeGreaterThan(connector.start.y);
    expect(connector.startShapeId).toBe(`shape-${box.id}`);
    expect(connector.endShapeId).toBe(`shape-${decision.id}`);
    expect(connector.strokeIds).toContain(head.id);

    // letters of a word end up together; 3 words, 3 targets
    expect(analysis.inks).toHaveLength(3);
    const targets = analysis.inks
      .map((inkGroup) => inkGroup.target.kind)
      .sort();
    expect(targets).toEqual(["connector", "free", "shape"]);
    const inBox = analysis.inks.find(
      (inkGroup) => inkGroup.target.kind === "shape",
    )!;
    expect(inBox.strokes).toHaveLength(5);
  });

  it("points the arrow at the end where its head is", () => {
    const head = arrowheadStroke([500, 100], [100, 100]);
    const analysis = analyze([lineStroke([100, 100], [500, 100]), head]);
    const [connector] = analysis.connectors;
    expect(connector.arrow).toBe(true);
    expect(connector.end.x).toBeLessThan(connector.start.x);
  });

  it("keeps a line without a head as a plain connector", () => {
    const analysis = analyze([lineStroke([100, 100], [400, 100])]);
    expect(analysis.connectors[0].arrow).toBe(false);
  });

  it("treats small closed strokes as letters, not shapes", () => {
    const analysis = analyze([ellipseStroke(100, 100, 18, 18)]);
    expect(analysis.shapes).toHaveLength(0);
    expect(analysis.inks).toHaveLength(1);
  });
});

describe("buildCleanSkeletons", () => {
  it("puts the read text into shapes, on arrows and as free text", () => {
    const box = rectangleStroke(100, 100, 220, 90);
    const target = ellipseStroke(100, 300, 220, 100);
    const shaft = lineStroke([210, 195], [210, 295]);
    const head = arrowheadStroke([210, 195], [210, 295]);
    const analysis = analyze([
      box,
      target,
      shaft,
      head,
      ...inkWord(150, 130, 5),
      ...inkWord(230, 230, 3, 18, 9),
      ...inkWord(600, 600, 4, 22, 11),
    ]);
    const texts = new Map(
      analysis.inks.map((inkGroup) => [
        inkGroup.id,
        inkGroup.target.kind === "shape"
          ? "Início"
          : inkGroup.target.kind === "connector"
          ? "Sim"
          : "Nota",
      ]),
    );

    const skeletons = buildCleanSkeletons(analysis, texts) as any[];

    const rectangle = skeletons.find((s) => s.type === "rectangle");
    expect(rectangle.label.text).toBe("Início");
    expect(rectangle.label.fontSize).toBeGreaterThanOrEqual(16);
    const arrow = skeletons.find((s) => s.type === "arrow");
    expect(arrow.label.text).toBe("Sim");
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.start.id).toBe(rectangle.id);
    expect(arrow.end.id).toBe(skeletons.find((s) => s.type === "ellipse").id);
    expect(skeletons.find((s) => s.type === "text").text).toBe("Nota");

    // everything was converted
    expect(consumedStrokeIds(analysis, texts).size).toBe(4 + 5 + 3 + 4);
  });

  it("leaves unreadable handwriting as it is", () => {
    const box = rectangleStroke(100, 100, 220, 90);
    const word = inkWord(150, 130, 5);
    const analysis = analyze([box, ...word]);
    const texts = new Map([[analysis.inks[0].id, null]]);

    const skeletons = buildCleanSkeletons(analysis, texts) as any[];

    expect(skeletons).toHaveLength(1);
    expect(skeletons[0].label).toBeUndefined();
    const consumed = consumedStrokeIds(analysis, texts);
    expect(consumed.has(box.id)).toBe(true);
    expect(word.some((stroke) => consumed.has(stroke.id))).toBe(false);
  });
});

describe("Clean up sketch (action in the editor)", () => {
  const drawSketch = () => {
    const box = rectangleStroke(100, 100, 220, 90);
    const end = ellipseStroke(100, 300, 220, 100);
    const shaft = lineStroke([210, 195], [210, 295]);
    const head = arrowheadStroke([210, 195], [210, 295]);
    const word = inkWord(150, 130, 5);
    return [box, end, shaft, head, ...word];
  };

  const run = async (
    recognizeHandwriting?: (
      images: Blob[],
      opts: any,
    ) => Promise<(string | null)[]>,
  ) => {
    await render(
      <Excalidraw
        handleKeyboardGlobally={true}
        recognizeHandwriting={recognizeHandwriting}
      />,
    );
    const strokes = drawSketch();
    API.updateScene({
      elements: syncInvalidIndices(strokes),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(strokes);
    expect(h.app.actionManager.isActionEnabled(actionCleanSketch)).toBe(true);
    API.executeAction(actionCleanSketch);
    await waitFor(() =>
      expect(
        h.elements.some((e) => !e.isDeleted && e.type === "rectangle"),
      ).toBe(true),
    );
    return strokes;
  };

  it("turns the sketch into shapes, a bound arrow and labels, in one undo step", async () => {
    const recognize = vi.fn().mockResolvedValue(["Início"]);
    const strokes = await run(recognize);

    const alive = h.elements.filter((e) => !e.isDeleted);
    expect(alive.some((e) => e.type === "freedraw")).toBe(false);
    const rectangle = alive.find((e) => e.type === "rectangle")!;
    const label = alive.find(
      (e) => e.type === "text" && (e as any).containerId === rectangle.id,
    ) as any;
    expect(label.text).toBe("Início");
    const arrow = alive.find((e) => e.type === "arrow") as any;
    expect(arrow.startBinding.elementId).toBe(rectangle.id);
    expect(arrow.endBinding.elementId).toBe(
      alive.find((e) => e.type === "ellipse")!.id,
    );

    // the reader got one image (the word inside the box) and the language
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0][0]).toHaveLength(1);
    expect(recognize.mock.calls[0][0][0]).toBeInstanceOf(Blob);
    expect(recognize.mock.calls[0][1].language).toBeTruthy();
    Keyboard.undo();
    const restored = h.elements.filter((e) => !e.isDeleted);
    expect(restored.map((e) => e.id).sort()).toEqual(
      strokes.map((stroke) => stroke.id).sort(),
    );
  });

  it("cleans shapes and keeps the handwriting when there is no reader", async () => {
    const strokes = await run(undefined);
    const alive = h.elements.filter((e) => !e.isDeleted);
    const word = strokes.slice(4);
    expect(
      alive
        .filter((e) => e.type === "freedraw")
        .map((e) => e.id)
        .sort(),
    ).toEqual(word.map((stroke) => stroke.id).sort());
    // grouped together, ready to be moved as one
    const groups = new Set(
      alive.filter((e) => e.type === "freedraw").map((e) => e.groupIds.at(-1)),
    );
    expect(groups.size).toBe(1);
    expect(h.state.toast?.message).toBeTruthy();
  });

  it("keeps the handwriting when the reader fails", async () => {
    await run(vi.fn().mockRejectedValue(new Error("servidor sem visão")));
    expect(String(h.state.toast?.message)).toContain("servidor sem visão");
    expect(h.elements.some((e) => !e.isDeleted && e.type === "freedraw")).toBe(
      true,
    );
  });
});
