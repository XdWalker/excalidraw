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
} from "@excalidraw/element";

import type { ELK, ElkNode, LayoutOptions } from "elkjs/lib/elk-api";

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
  // edges leaving/entering a shape share one point (the middle of the side,
  // i.e. a diamond's tip) and split/join after it, as in hand-drawn flowcharts
  "elk.layered.mergeEdges": "true",
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
 * Computes the top-left position of every node and the route of every edge.
 * Coordinates are relative to the layout's own origin; `applyOrganizeLayout`
 * anchors them in the scene.
 */
export const computeOrganizeLayout = async (
  graph: OrganizeGraph,
  direction: OrganizeDirection,
): Promise<OrganizeLayout> => {
  const elk = await loadElk();

  const root: ElkNode = {
    id: "__organize_root__",
    layoutOptions: getOrganizeLayoutOptions(direction),
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
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
