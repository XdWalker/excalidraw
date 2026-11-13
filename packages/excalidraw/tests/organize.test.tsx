import { pointFrom } from "@excalidraw/math";

import {
  applyOrganizeLayout,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getOrganizeGraph,
  guessOrganizeDirection,
  Scene,
} from "@excalidraw/element";

import type { LocalPoint } from "@excalidraw/math";

import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type {
  ExcalidrawElementSkeleton,
  OrganizeDirection,
} from "@excalidraw/element";

import { actionOrganize } from "../actions";
import { Excalidraw } from "../index";
import { computeOrganizeLayout } from "../organize/elkLayout";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, unmountComponent, waitFor } from "./test-utils";

const { h } = window;

const noAppState = { selectedGroupIds: {}, editingGroupId: null };

/**
 * A messy diagram: B at the top-left, A far to the right, C at the bottom,
 * D to the left; arrows B->A, B->C ("Sim") and C->D.
 */
const messySkeleton = (): ExcalidrawElementSkeleton[] => [
  {
    type: "rectangle",
    id: "B",
    x: 0,
    y: 0,
    width: 120,
    height: 60,
    label: { text: "Início" },
  },
  { type: "rectangle", id: "A", x: 700, y: 380, width: 120, height: 60 },
  { type: "diamond", id: "C", x: 260, y: 650, width: 140, height: 90 },
  { type: "ellipse", id: "D", x: -300, y: 300, width: 120, height: 60 },
  {
    type: "arrow",
    id: "BA",
    x: 120,
    y: 30,
    points: [pointFrom(0, 0), pointFrom(580, 380)],
    start: { id: "B" },
    end: { id: "A" },
  },
  {
    type: "arrow",
    id: "BC",
    x: 60,
    y: 60,
    points: [pointFrom(0, 0), pointFrom(260, 590)],
    start: { id: "B" },
    end: { id: "C" },
    label: { text: "Sim" },
  },
  {
    type: "arrow",
    id: "CD",
    x: 260,
    y: 695,
    points: [pointFrom(0, 0), pointFrom(-440, -335)],
    start: { id: "C" },
    end: { id: "D" },
  },
];

const createScene = (skeleton = messySkeleton()) =>
  new Scene(convertToExcalidrawElements(skeleton, { regenerateIds: false }), {
    skipValidation: true,
  });

const shapesOf = (elements: readonly ExcalidrawElement[]) =>
  elements.filter(
    (element) =>
      !element.isDeleted &&
      ["rectangle", "diamond", "ellipse"].includes(element.type),
  ) as NonDeletedExcalidrawElement[];

const overlaps = (a: ExcalidrawElement, b: ExcalidrawElement) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const organize = async (
  scene: Scene,
  selected: readonly NonDeletedExcalidrawElement[],
  direction?: OrganizeDirection,
  appState: {
    selectedGroupIds: Record<string, boolean>;
    editingGroupId: string | null;
  } = noAppState,
) => {
  const graph = getOrganizeGraph(
    selected,
    scene.getNonDeletedElementsMap(),
    appState,
  );
  const dir = direction ?? guessOrganizeDirection(graph);
  const layout = await computeOrganizeLayout(graph, dir);
  applyOrganizeLayout(graph, layout, dir, scene);
  return { graph, direction: dir };
};

/** arrow end point in scene coordinates */
const arrowEnd = (arrow: ExcalidrawArrowElement, end: "start" | "end") => {
  const point = arrow.points[end === "start" ? 0 : arrow.points.length - 1];
  return { x: arrow.x + point[0], y: arrow.y + point[1] };
};

const distanceToBox = (
  point: { x: number; y: number },
  box: ExcalidrawElement,
) => {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
};

describe("organize: graph from the selection", () => {
  it("makes shapes nodes and bound arrows edges (with label sizes)", () => {
    const scene = createScene();
    const graph = getOrganizeGraph(
      scene.getNonDeletedElements(),
      scene.getNonDeletedElementsMap(),
      noAppState,
    );

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(
      graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort(),
    ).toEqual(["B->A", "B->C", "C->D"]);
    expect(graph.edges.find((edge) => edge.id === "BC")?.label?.text).toBe(
      "Sim",
    );
    // the container's label moves with it
    const nodeB = graph.nodes.find((node) => node.id === "B")!;
    expect(nodeB.elements.map((element) => element.type)).toEqual([
      "rectangle",
      "text",
    ]);
  });

  it("finds arrows between selected shapes even if the arrows aren't selected", () => {
    const scene = createScene();
    const graph = getOrganizeGraph(
      shapesOf(scene.getNonDeletedElements()),
      scene.getNonDeletedElementsMap(),
      noAppState,
    );
    expect(graph.edges).toHaveLength(3);
  });

  it("ignores arrows to shapes outside the selection", () => {
    const scene = createScene();
    const selected = shapesOf(scene.getNonDeletedElements()).filter(
      (element) => element.id !== "D",
    );
    const graph = getOrganizeGraph(
      selected,
      scene.getNonDeletedElementsMap(),
      noAppState,
    );
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(["BA", "BC"]);
  });

  it("prefers top-to-bottom for a scattered diagram", () => {
    // arrows go 1540px sideways and 1365px up/down: no clear orientation
    const scene = createScene();
    expect(
      guessOrganizeDirection(
        getOrganizeGraph(
          scene.getNonDeletedElements(),
          scene.getNonDeletedElementsMap(),
          noAppState,
        ),
      ),
    ).toBe("DOWN");
  });

  it("guesses the orientation from the arrows", () => {
    const vertical = createScene([
      { type: "rectangle", id: "P", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "Q", x: 40, y: 400, width: 100, height: 50 },
      {
        type: "arrow",
        x: 50,
        y: 50,
        points: [pointFrom(0, 0), pointFrom(40, 350)],
        start: { id: "P" },
        end: { id: "Q" },
      },
    ]);
    expect(
      guessOrganizeDirection(
        getOrganizeGraph(
          vertical.getNonDeletedElements(),
          vertical.getNonDeletedElementsMap(),
          noAppState,
        ),
      ),
    ).toBe("DOWN");

    const horizontal = createScene([
      { type: "rectangle", id: "P", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "Q", x: 400, y: 30, width: 100, height: 50 },
      {
        type: "arrow",
        x: 100,
        y: 25,
        points: [pointFrom(0, 0), pointFrom(300, 30)],
        start: { id: "P" },
        end: { id: "Q" },
      },
    ]);
    expect(
      guessOrganizeDirection(
        getOrganizeGraph(
          horizontal.getNonDeletedElements(),
          horizontal.getNonDeletedElementsMap(),
          noAppState,
        ),
      ),
    ).toBe("RIGHT");
  });
});

describe("organize: layout", () => {
  it("lays out top-to-bottom without overlaps, keeping arrows bound", async () => {
    const scene = createScene();
    const before = new Map(
      shapesOf(scene.getNonDeletedElements()).map((element) => [
        element.id,
        { x: element.x, y: element.y },
      ]),
    );
    const oldTop = Math.min(...[...before.values()].map((pos) => pos.y));

    await organize(scene, scene.getNonDeletedElements(), "DOWN");

    const shapes = shapesOf(scene.getNonDeletedElements());
    const byId = new Map(shapes.map((shape) => [shape.id, shape]));

    // nothing overlaps
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(overlaps(shapes[i], shapes[j])).toBe(false);
      }
    }

    // every arrow goes downwards (the graph has no cycle)
    for (const [source, target] of [
      ["B", "A"],
      ["B", "C"],
      ["C", "D"],
    ]) {
      const s = byId.get(source)!;
      const t = byId.get(target)!;
      expect(t.y).toBeGreaterThanOrEqual(s.y + s.height);
    }

    // anchored at the old top
    expect(Math.min(...shapes.map((shape) => shape.y))).toBeCloseTo(oldTop);

    // arrows still bound and touching their shapes
    for (const id of ["BA", "BC", "CD"]) {
      const arrow = scene.getElement(id) as ExcalidrawArrowElement;
      const start = byId.get(arrow.startBinding!.elementId)!;
      const end = byId.get(arrow.endBinding!.elementId)!;
      expect(distanceToBox(arrowEnd(arrow, "start"), start)).toBeLessThan(15);
      expect(distanceToBox(arrowEnd(arrow, "end"), end)).toBeLessThan(15);
    }

    // the container's label moved with it
    const container = byId.get("B")!;
    const label = scene
      .getNonDeletedElements()
      .find(
        (element) =>
          element.type === "text" &&
          (element as ExcalidrawTextElement).containerId === "B",
      )!;
    expect(label.x).toBeGreaterThanOrEqual(container.x);
    expect(label.x + label.width).toBeLessThanOrEqual(
      container.x + container.width,
    );
    expect(label.y).toBeGreaterThanOrEqual(container.y);
  });

  it("lays out left-to-right", async () => {
    const scene = createScene();
    await organize(scene, scene.getNonDeletedElements(), "RIGHT");
    const byId = new Map(
      shapesOf(scene.getNonDeletedElements()).map((shape) => [shape.id, shape]),
    );
    const b = byId.get("B")!;
    const c = byId.get("C")!;
    const d = byId.get("D")!;
    expect(c.x).toBeGreaterThanOrEqual(b.x + b.width);
    expect(d.x).toBeGreaterThanOrEqual(c.x + c.width);
  });

  it("moves a group as a single node", async () => {
    const scene = createScene([
      {
        type: "rectangle",
        id: "G1",
        x: 0,
        y: 0,
        width: 80,
        height: 40,
        groupIds: ["g"],
      },
      {
        type: "rectangle",
        id: "G2",
        x: 100,
        y: 0,
        width: 80,
        height: 40,
        groupIds: ["g"],
      },
      { type: "rectangle", id: "X", x: 600, y: 600, width: 80, height: 40 },
      {
        type: "arrow",
        x: 180,
        y: 20,
        points: [pointFrom(0, 0), pointFrom(420, 580)],
        start: { id: "G2" },
        end: { id: "X" },
      },
    ]);
    const g1 = () => scene.getElement("G1")!;
    const g2 = () => scene.getElement("G2")!;
    const gap = g2().x - g1().x;

    // as in the editor, where selecting a group marks it as selected
    const { graph } = await organize(
      scene,
      scene.getNonDeletedElements(),
      "DOWN",
      { selectedGroupIds: { g: true }, editingGroupId: null },
    );

    expect(graph.nodes).toHaveLength(2);
    expect(g2().x - g1().x).toBeCloseTo(gap);
    expect(g2().y).toBeCloseTo(g1().y);
    expect(scene.getElement("X")!.y).toBeGreaterThan(g1().y + 40);
  });

  it("handles cycles and disconnected shapes", async () => {
    const scene = createScene([
      { type: "rectangle", id: "P", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "Q", x: 0, y: 300, width: 100, height: 50 },
      { type: "rectangle", id: "R", x: 300, y: 100, width: 100, height: 50 },
      {
        type: "arrow",
        x: 50,
        y: 50,
        points: [pointFrom(0, 0), pointFrom(0, 250)],
        start: { id: "P" },
        end: { id: "Q" },
      },
      {
        type: "arrow",
        x: 60,
        y: 300,
        points: [pointFrom(0, 0), pointFrom(0, -250)],
        start: { id: "Q" },
        end: { id: "P" },
      },
    ]);

    await organize(scene, scene.getNonDeletedElements(), "DOWN");

    const shapes = shapesOf(scene.getNonDeletedElements());
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(overlaps(shapes[i], shapes[j])).toBe(false);
      }
    }
  });
});

/** segment p-q crosses the rectangle (shrunk by `inset` so touching is ok) */
const segmentCrossesBox = (
  p: { x: number; y: number },
  q: { x: number; y: number },
  box: ExcalidrawElement,
  inset = 4,
) => {
  const minX = box.x + inset;
  const maxX = box.x + box.width - inset;
  const minY = box.y + inset;
  const maxY = box.y + box.height - inset;
  // sample the segment: enough for the axis-aligned/short segments we check
  for (let i = 0; i <= 50; i++) {
    const x = p.x + ((q.x - p.x) * i) / 50;
    const y = p.y + ((q.y - p.y) * i) / 50;
    if (x > minX && x < maxX && y > minY && y < maxY) {
      return true;
    }
  }
  return false;
};

/** the login flow scattered around, as in the manual test of fase 2 */
const loginSkeleton = (): ExcalidrawElementSkeleton[] => {
  const nodes: [
    string,
    "rectangle" | "diamond" | "ellipse",
    string,
    number,
    number,
  ][] = [
    ["ini", "rectangle", "Início", 820, 40],
    ["dig", "rectangle", "Digitar e-mail e senha", 80, 520],
    ["cred", "diamond", "Credenciais válidas?", 600, 300],
    ["erro", "rectangle", "Mostrar erro", 1050, 600],
    ["fa", "diamond", "2FA ativo?", 150, 120],
    ["cod", "rectangle", "Pedir código", 560, 700],
    ["painel", "ellipse", "Abrir painel", 1100, 250],
  ];
  const size = {
    rectangle: [170, 70],
    diamond: [190, 110],
    ellipse: [170, 80],
  };
  const edges: [string, string, string?][] = [
    ["ini", "dig"],
    ["dig", "cred"],
    ["cred", "erro", "Não"],
    ["erro", "dig"],
    ["cred", "fa", "Sim"],
    ["fa", "cod", "Sim"],
    ["fa", "painel", "Não"],
    ["cod", "painel"],
  ];
  const center = (id: string) => {
    const [, type, , x, y] = nodes.find((node) => node[0] === id)!;
    return { x: x + size[type][0] / 2, y: y + size[type][1] / 2 };
  };
  return [
    ...nodes.map(([id, type, text, x, y]) => ({
      type,
      id,
      x,
      y,
      width: size[type][0],
      height: size[type][1],
      label: { text },
    })),
    ...edges.map(([source, target, label], index) => {
      const a = center(source);
      const b = center(target);
      return {
        type: "arrow" as const,
        id: `e${index}`,
        x: a.x,
        y: a.y,
        points: [
          pointFrom<LocalPoint>(0, 0),
          pointFrom<LocalPoint>(b.x - a.x, b.y - a.y),
        ],
        start: { id: source },
        end: { id: target },
        ...(label ? { label: { text: label } } : {}),
      };
    }),
  ];
};

describe("organize: arrows", () => {
  it("routes straight arrows around the other shapes", async () => {
    const scene = createScene(loginSkeleton());
    await organize(scene, scene.getNonDeletedElements(), "DOWN");

    const shapes = shapesOf(scene.getNonDeletedElements());
    const arrows = scene
      .getNonDeletedElements()
      .filter(
        (element) => element.type === "arrow",
      ) as ExcalidrawArrowElement[];
    expect(arrows).toHaveLength(8);

    for (const arrow of arrows) {
      const ends = [arrow.startBinding?.elementId, arrow.endBinding?.elementId];
      const points = arrow.points.map(([x, y]) => ({
        x: arrow.x + x,
        y: arrow.y + y,
      }));
      for (const shape of shapes) {
        if (ends.includes(shape.id)) {
          continue;
        }
        for (let i = 0; i < points.length - 1; i++) {
          expect({
            arrow: arrow.id,
            shape: shape.id,
            crosses: segmentCrossesBox(points[i], points[i + 1], shape),
          }).toEqual({ arrow: arrow.id, shape: shape.id, crosses: false });
        }
      }
    }
  });

  it("draws loops back up and everything else down", async () => {
    const scene = createScene(loginSkeleton());
    await organize(scene, scene.getNonDeletedElements(), "DOWN");
    const byId = new Map(
      shapesOf(scene.getNonDeletedElements()).map((shape) => [shape.id, shape]),
    );
    const goingUp = scene
      .getNonDeletedElements()
      .filter((element) => element.type === "arrow")
      .filter((element) => {
        const arrow = element as ExcalidrawArrowElement;
        return (
          byId.get(arrow.endBinding!.elementId)!.y <
          byId.get(arrow.startBinding!.elementId)!.y
        );
      })
      .map((arrow) => arrow.id);
    // "Mostrar erro" -> back to "Digitar e-mail e senha"
    expect(goingUp).toEqual(["e3"]);
  });
});

describe("organize: action in the editor", () => {
  beforeEach(async () => {
    unmountComponent();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("organizes the selection in one undoable step", async () => {
    const elements = convertToExcalidrawElements(messySkeleton(), {
      regenerateIds: false,
    });
    API.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(shapesOf(h.elements));

    const positionsOf = () =>
      shapesOf(h.elements)
        .map((element) => `${element.id}:${element.x},${element.y}`)
        .sort()
        .join(" ");
    const before = positionsOf();

    expect(h.app.actionManager.isActionEnabled(actionOrganize)).toBe(true);

    API.executeAction(actionOrganize);
    await waitFor(() => expect(positionsOf()).not.toBe(before));
    const after = positionsOf();

    const shapes = shapesOf(h.elements);
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(overlaps(shapes[i], shapes[j])).toBe(false);
      }
    }

    Keyboard.undo();
    expect(positionsOf()).toBe(before);
    Keyboard.redo();
    expect(positionsOf()).toBe(after);
  });

  it("is not available for a single shape", () => {
    const elements = convertToExcalidrawElements(messySkeleton(), {
      regenerateIds: false,
    });
    API.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(
      shapesOf(h.elements).filter((element) => element.id === "A"),
    );

    expect(h.app.actionManager.isActionEnabled(actionOrganize)).toBe(false);
  });
});
