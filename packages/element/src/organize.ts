/**
 * "Organizar" (fork ia-local): reorganiza um diagrama selecionado com um
 * algoritmo de layout de grafos, mantendo as setas presas às caixas.
 *
 * Este módulo não depende do motor de layout: ele monta o grafo a partir da
 * seleção e aplica as posições calculadas (pelo ELK, no pacote do editor).
 */
import { pointFrom } from "@excalidraw/math";

import type { AppState } from "@excalidraw/excalidraw/types";

import type { GlobalPoint, LocalPoint } from "@excalidraw/math";

import {
  calculateFixedPointForNonElbowArrowBinding,
  updateBoundElements,
} from "./binding";
import { getCommonBoundingBox } from "./bounds";
import { getSelectedElementsByGroup } from "./groups";
import { getBoundTextElement } from "./textElement";
import {
  isArrowElement,
  isBindableElement,
  isBoundToContainer,
  isElbowArrow,
  isLinearElement,
} from "./typeChecks";

import { getNonDeletedElements } from ".";

import type { RenderEnvironment } from "./renderEnvironment";
import type { Scene } from "./Scene";
import type {
  ElementsMap,
  ExcalidrawArrowElement,
  FixedPoint,
  FixedPointBinding,
  NonDeletedExcalidrawElement,
} from "./types";

export type OrganizeDirection = "DOWN" | "RIGHT";

const HORIZONTAL_BIAS = 1.5;

export type OrganizeNode = {
  /** id of the first element of the node (a shape, or a group's member) */
  id: string;
  /** everything that moves together: the shape (or group) + bound texts */
  elements: readonly NonDeletedExcalidrawElement[];
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * shapes whose bounding box corners are empty: arrows should leave and
   * arrive at the tips (diamond) or the middle of the sides (ellipse)
   */
  tipped: boolean;
};

export type OrganizeEdge = {
  /** the arrow's id */
  id: string;
  source: string;
  target: string;
  /** size of the arrow's label, if any, so the layout leaves room for it */
  label?: { text: string; width: number; height: number };
};

export type OrganizeGraph = {
  nodes: OrganizeNode[];
  edges: OrganizeEdge[];
};

export type OrganizeLayout = {
  /** top-left corner of every node */
  nodes: ReadonlyMap<string, { x: number; y: number }>;
  /**
   * route of every edge (start, bends, end), in the same coordinates: the
   * layout's routes go around the other nodes
   */
  edges?: ReadonlyMap<string, readonly { x: number; y: number }[]>;
};

/**
 * A selection bucket (see `getSelectedElementsByGroup`) is a node unless it
 * only holds arrows/lines (and their labels): those are edges, re-routed
 * after the nodes move.
 */
export const isOrganizeNodeBucket = (
  bucket: readonly NonDeletedExcalidrawElement[],
) =>
  !bucket
    .filter((element) => !isBoundToContainer(element))
    .every((element) => isLinearElement(element));

/**
 * Turns the selection into a graph:
 * - nodes: each selected shape or group (with its bound text);
 * - edges: arrows bound at both ends to two different nodes, whether the
 *   arrows themselves are selected or not.
 *
 * Arrows and lines that are not part of a group are not nodes: they are
 * re-routed after the nodes move. Nodes and edges are returned in flow
 * order (see `orderByFlow`), which the layout uses as a tie-breaker.
 */
export const getOrganizeGraph = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  appState: Readonly<Pick<AppState, "selectedGroupIds" | "editingGroupId">>,
): OrganizeGraph => {
  const buckets = getSelectedElementsByGroup(
    [...selectedElements],
    elementsMap,
    appState,
  )
    .map(getNonDeletedElements)
    .filter((bucket) => bucket.length > 0);

  const nodes: OrganizeNode[] = [];
  const nodeIdByElementId = new Map<string, string>();
  const candidateArrows = new Map<string, ExcalidrawArrowElement>();

  for (const bucket of buckets) {
    if (!isOrganizeNodeBucket(bucket)) {
      bucket.forEach((element) => {
        if (isArrowElement(element)) {
          candidateArrows.set(element.id, element);
        }
      });
      continue;
    }

    const bbox = getCommonBoundingBox(bucket);
    const node: OrganizeNode = {
      id: bucket[0].id,
      elements: bucket,
      x: bbox.minX,
      y: bbox.minY,
      width: bbox.width,
      height: bbox.height,
      tipped:
        bucket.filter((element) => !isBoundToContainer(element)).length === 1 &&
        (bucket[0].type === "diamond" || bucket[0].type === "ellipse"),
    };
    nodes.push(node);

    for (const element of bucket) {
      nodeIdByElementId.set(element.id, node.id);
      // arrows bound to this node, even if they aren't selected
      element.boundElements?.forEach(({ id, type }) => {
        const arrow = elementsMap.get(id);
        if (type === "arrow" && arrow && isArrowElement(arrow)) {
          candidateArrows.set(arrow.id, arrow);
        }
      });
    }
  }

  const edges: OrganizeEdge[] = [];
  for (const arrow of candidateArrows.values()) {
    if (arrow.isDeleted) {
      continue;
    }
    const source = arrow.startBinding
      ? nodeIdByElementId.get(arrow.startBinding.elementId)
      : undefined;
    const target = arrow.endBinding
      ? nodeIdByElementId.get(arrow.endBinding.elementId)
      : undefined;
    // arrows inside a moved group are moved with the group, not routed
    const arrowNode = nodeIdByElementId.get(arrow.id);
    if (!source || !target || source === target || arrowNode) {
      continue;
    }
    const labelElement = getBoundTextElement(arrow, elementsMap);
    edges.push({
      id: arrow.id,
      source,
      target,
      label: labelElement
        ? {
            text: labelElement.text,
            width: labelElement.width,
            height: labelElement.height,
          }
        : undefined,
    });
  }

  return orderByFlow(nodes, edges);
};

/**
 * Orders nodes along the flow: depth-first from the start nodes (no incoming
 * arrow), in reading order (top-to-bottom, left-to-right) only to pick
 * between several starts. The layout uses this order as a tie-breaker, and
 * since it doesn't depend on where the shapes currently are, organizing an
 * already organized diagram leaves it as it is.
 */
const orderByFlow = (
  nodes: OrganizeNode[],
  edges: OrganizeEdge[],
): OrganizeGraph => {
  const readingOrder = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const outgoing = new Map<string, OrganizeEdge[]>();
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const visit = (id: string) => {
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      if (rank.has(current)) {
        continue;
      }
      rank.set(current, rank.size);
      // reversed so the first outgoing arrow is visited first
      const next = (outgoing.get(current) ?? []).map((edge) => edge.target);
      for (let i = next.length - 1; i >= 0; i--) {
        if (!rank.has(next[i])) {
          stack.push(next[i]);
        }
      }
    }
  };
  readingOrder
    .filter((node) => !incoming.get(node.id))
    .forEach((node) => visit(node.id));
  // whatever is only reachable through a loop
  readingOrder.forEach((node) => visit(node.id));

  const order = (id: string) => rank.get(id) ?? Infinity;
  return {
    nodes: [...nodes].sort((a, b) => order(a.id) - order(b.id)),
    edges: [...edges].sort(
      (a, b) =>
        order(a.source) - order(b.source) || order(a.target) - order(b.target),
    ),
  };
};

/**
 * Keeps the diagram's orientation when it clearly has one: horizontal only if
 * its arrows go clearly more sideways than up/down (1.5x), so a scribbled,
 * scattered diagram gets the usual top-to-bottom flowchart layout.
 */
export const guessOrganizeDirection = (
  graph: OrganizeGraph,
): OrganizeDirection => {
  const centers = new Map(
    graph.nodes.map((node) => [
      node.id,
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
    ]),
  );
  let horizontal = 0;
  let vertical = 0;
  for (const edge of graph.edges) {
    const source = centers.get(edge.source);
    const target = centers.get(edge.target);
    if (source && target) {
      horizontal += Math.abs(target.x - source.x);
      vertical += Math.abs(target.y - source.y);
    }
  }
  return horizontal > vertical * HORIZONTAL_BIAS ? "RIGHT" : "DOWN";
};

/**
 * Moves every node to its new position (top-left corners from the layout)
 * and re-routes the bound arrows, which stay attached.
 *
 * Straight (non-elbow) arrows follow the layout's routes, so they bend around
 * the other shapes instead of crossing them; their ends stay bound where the
 * route meets the shape. Elbow arrows keep routing themselves, but from the
 * sides of the shapes the layout chose.
 *
 * The new layout is anchored where the old one was: same top and horizontal
 * center for a vertical layout, same left and vertical center for a
 * horizontal one, so the diagram doesn't jump away from the viewport.
 */
export const applyOrganizeLayout = (
  graph: OrganizeGraph,
  layout: OrganizeLayout,
  direction: OrganizeDirection,
  scene: Scene,
  renderEnvironment?: RenderEnvironment,
): NonDeletedExcalidrawElement[] => {
  const positions = layout.nodes;
  const nodes = graph.nodes.filter((node) => positions.has(node.id));
  if (!nodes.length) {
    return [];
  }

  const oldBox = getBox(nodes.map((node) => node));
  const newBox = getBox(
    nodes.map((node) => ({ ...node, ...positions.get(node.id)! })),
  );
  const offset =
    direction === "DOWN"
      ? { x: oldBox.midX - newBox.midX, y: oldBox.minY - newBox.minY }
      : { x: oldBox.minX - newBox.minX, y: oldBox.midY - newBox.midY };

  const moved: NonDeletedExcalidrawElement[] = [];
  for (const node of nodes) {
    const target = positions.get(node.id)!;
    const dx = target.x + offset.x - node.x;
    const dy = target.y + offset.y - node.y;
    for (const element of node.elements) {
      moved.push(
        scene.mutateElement(element, {
          x: element.x + dx,
          y: element.y + dy,
        }),
      );
    }
  }

  const routed = applyEdgeRoutes(graph, layout, offset, scene);

  // only after every node is in place, so each arrow is routed once against
  // its final source and target
  for (const element of moved) {
    updateBoundElements(element, scene, {
      simultaneouslyUpdated: moved,
      renderEnvironment,
    });
  }

  return [...moved, ...routed];
};

const applyEdgeRoutes = (
  graph: OrganizeGraph,
  layout: OrganizeLayout,
  offset: { x: number; y: number },
  scene: Scene,
) => {
  const routed: NonDeletedExcalidrawElement[] = [];
  const elementsMap = scene.getNonDeletedElementsMap();

  for (const edge of graph.edges) {
    const route = layout.edges?.get(edge.id);
    const arrow = elementsMap.get(edge.id);
    if (!route || route.length < 2 || !arrow || !isArrowElement(arrow)) {
      continue;
    }

    const points = route.map(({ x, y }) =>
      pointFrom<GlobalPoint>(x + offset.x, y + offset.y),
    );

    if (isElbowArrow(arrow)) {
      // elbow arrows route themselves: attach them on the sides the layout
      // chose (e.g. bottom of the source, top of the target) and drop any
      // segment the user had pinned, so the router starts from scratch
      const bindings: {
        startBinding?: FixedPointBinding;
        endBinding?: FixedPointBinding;
      } = {};
      for (const end of ["start", "end"] as const) {
        const key = end === "start" ? "startBinding" : "endBinding";
        const binding = arrow[key];
        const target = binding ? elementsMap.get(binding.elementId) : undefined;
        if (binding && target && target.width > 0 && target.height > 0) {
          const [px, py] =
            end === "start" ? points[0] : points[points.length - 1];
          bindings[key] = {
            ...binding,
            fixedPoint: [
              (px - target.x) / target.width,
              (py - target.y) / target.height,
            ] as FixedPoint,
          };
        }
      }
      scene.mutateElement(arrow, {
        ...bindings,
        fixedSegments: null,
        startIsSpecial: null,
        endIsSpecial: null,
      });
      routed.push(arrow);
      continue;
    }
    const [x0, y0] = points[0];
    scene.mutateElement(arrow, {
      x: x0,
      y: y0,
      points: points.map(([x, y]) => pointFrom<LocalPoint>(x - x0, y - y0)),
    });

    // bind the ends where the route meets the shapes
    for (const end of ["start", "end"] as const) {
      const key = end === "start" ? "startBinding" : "endBinding";
      const binding = arrow[key];
      const target = binding ? elementsMap.get(binding.elementId) : undefined;
      if (!binding || !target || !isBindableElement(target)) {
        continue;
      }
      const { fixedPoint } = calculateFixedPointForNonElbowArrowBinding(
        arrow,
        target,
        end,
        elementsMap,
        end === "start" ? points[0] : points[points.length - 1],
      );
      scene.mutateElement(arrow, { [key]: { ...binding, fixedPoint } });
    }

    routed.push(arrow);
  }

  return routed;
};

const getBox = (
  rects: readonly { x: number; y: number; width: number; height: number }[],
) => {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { minX, minY, midX: (minX + maxX) / 2, midY: (minY + maxY) / 2 };
};
