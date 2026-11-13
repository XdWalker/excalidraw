/**
 * Layout de grafos com o ELK (Eclipse Layout Kernel, via elkjs) para a ação
 * "Organizar" (fork ia-local). O elkjs (~1,5 MB) só é baixado no primeiro uso.
 *
 * elkjs: EPL-2.0 OR GPL-3.0-or-later, usado sem modificação.
 */
import type {
  OrganizeDirection,
  OrganizeGraph,
  OrganizeLayout,
  OrganizeNode,
} from "@excalidraw/element";

import type { ELK, ElkNode, ElkPort, LayoutOptions } from "elkjs/lib/elk-api";

let elkPromise: Promise<ELK> | null = null;

const loadElk = () => {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(
      ({ default: ElkConstructor }) => new ElkConstructor(),
    );
    // a failed load (e.g. offline before the chunk was cached) can be retried
    elkPromise.catch(() => {
      elkPromise = null;
    });
  }
  return elkPromise;
};

export const ORGANIZE_SPACING = {
  /** between nodes of the same layer */
  node: 60,
  /** between layers (rows in a vertical layout, columns in a horizontal one) */
  layer: 90,
  /** between disconnected parts of the selection */
  component: 120,
};

export const getOrganizeLayoutOptions = (
  direction: OrganizeDirection,
): LayoutOptions => ({
  "elk.algorithm": "layered",
  "elk.direction": direction,
  "elk.spacing.nodeNode": String(ORGANIZE_SPACING.node),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(ORGANIZE_SPACING.layer),
  "elk.spacing.componentComponent": String(ORGANIZE_SPACING.component),
  "elk.spacing.edgeLabel": "8",
  // "Sim"/"Não" labels sit on their arrow instead of taking a whole layer
  "elk.edgeLabels.inline": "true",
  "elk.edgeRouting": "ORTHOGONAL",
  // room for the last segment before a shape, so arrowheads stay visible
  "elk.layered.spacing.edgeNodeBetweenLayers": "30",
  // every arrow gets its own track: merging them (one exit point per side)
  // looked neat on small flowcharts but piled arrows on top of each other
  // on big ones (fase 2b: 1752px of overlapping arrows -> 0)
  "elk.layered.mergeEdges": "false",
  "elk.spacing.edgeEdge": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
  "elk.spacing.edgeNode": "25",
  // arrows going back to an earlier step get their own route, so the loop
  // stays visible
  "elk.layered.feedbackEdges": "true",
  // loops (e.g. "error -> back to the form") are drawn as arrows going back
  // up: a depth-first walk from the start of the flow only reverses the edges
  // that return to an earlier step
  "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
  // keep the user's reading order where the layout allows it
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  // straight vertical/horizontal runs instead of zig-zags
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.separateConnectedComponents": "true",
});

/**
 * Diamonds and ellipses: every arrow leaves from the tip facing the flow
 * (bottom, or right in a horizontal layout) and arrives at the opposite tip,
 * as in a hand-drawn flowchart, instead of from the empty corners of the
 * shape's bounding box.
 */
const tipPorts = (
  node: OrganizeNode,
  graph: OrganizeGraph,
  direction: OrganizeDirection,
): ElkPort[] => {
  const down = direction === "DOWN";
  const outPoint = down
    ? { x: node.width / 2, y: node.height, side: "SOUTH" }
    : { x: node.width, y: node.height / 2, side: "EAST" };
  const inPoint = down
    ? { x: node.width / 2, y: 0, side: "NORTH" }
    : { x: 0, y: node.height / 2, side: "WEST" };
  const ports: ElkPort[] = [];
  for (const edge of graph.edges) {
    if (edge.source === node.id) {
      ports.push({
        id: `${edge.id}:out`,
        x: outPoint.x,
        y: outPoint.y,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": outPoint.side },
      });
    }
    if (edge.target === node.id) {
      ports.push({
        id: `${edge.id}:in`,
        x: inPoint.x,
        y: inPoint.y,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": inPoint.side },
      });
    }
  }
  return ports;
};

/**
 * Computes the top-left position of every node and the route of every edge.
 * Coordinates are relative to the layout's own origin; `applyOrganizeLayout`
 * anchors them in the scene.
 */
export const computeOrganizeLayout = async (
  graph: OrganizeGraph,
  direction: OrganizeDirection,
  /** extra/overriding ELK options (used to compare settings in tests) */
  overrides?: LayoutOptions,
): Promise<OrganizeLayout> => {
  const elk = await loadElk();

  const tipped = new Set(
    graph.nodes.filter((node) => node.tipped).map((node) => node.id),
  );

  const root: ElkNode = {
    id: "__organize_root__",
    layoutOptions: { ...getOrganizeLayoutOptions(direction), ...overrides },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
      ...(node.tipped
        ? {
            layoutOptions: { "elk.portConstraints": "FIXED_POS" },
            ports: tipPorts(node, graph, direction),
          }
        : {}),
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [tipped.has(edge.source) ? `${edge.id}:out` : edge.source],
      targets: [tipped.has(edge.target) ? `${edge.id}:in` : edge.target],
      labels: edge.label
        ? [
            {
              text: edge.label.text,
              width: edge.label.width,
              height: edge.label.height,
            },
          ]
        : [],
    })),
  };

  const result = await elk.layout(root);

  const nodes = new Map(
    (result.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );

  const edges = new Map<string, { x: number; y: number }[]>();
  for (const edge of result.edges ?? []) {
    const section = edge.sections?.[0];
    if (section) {
      edges.set(edge.id, [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]);
    }
  }

  return { nodes, edges };
};
