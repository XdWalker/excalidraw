import {
  applyOrganizeLayout,
  getOrganizeGraph,
  guessOrganizeDirection,
} from "@excalidraw/element";

import type { OrganizeDirection, Scene } from "@excalidraw/element";

import { computeOrganizeLayout } from "../organize/elkLayout";

import {
  bigFlow,
  loginFlow,
  measureOrganizeQuality,
  sceneFrom,
  shapePositions,
} from "./helpers/organizeQuality";

const organize = async (scene: Scene, direction?: OrganizeDirection) => {
  const graph = getOrganizeGraph(
    scene.getNonDeletedElements(),
    scene.getNonDeletedElementsMap(),
    { selectedGroupIds: {}, editingGroupId: null },
  );
  const dir = direction ?? guessOrganizeDirection(graph);
  applyOrganizeLayout(
    graph,
    await computeOrganizeLayout(graph, dir),
    dir,
    scene,
  );
};

const maxMove = (
  a: ReturnType<typeof shapePositions>,
  b: ReturnType<typeof shapePositions>,
) =>
  Math.max(
    ...[...a].map(([id, p]) =>
      Math.hypot(p.x - b.get(id)!.x, p.y - b.get(id)!.y),
    ),
  );

const report = async (name: string, skeleton: () => any) => {
  const scene = sceneFrom(skeleton());
  await organize(scene, "DOWN");
  const quality = measureOrganizeQuality(scene);
  const first = shapePositions(scene);
  await organize(scene, "DOWN");
  const secondRunMove = Math.round(maxMove(first, shapePositions(scene)));
  // eslint-disable-next-line no-console
  console.log(`[organize quality] ${name}`, { ...quality, secondRunMove });
  return { ...quality, secondRunMove };
};

describe("organize: readability metrics (fase 2b)", () => {
  // before fase 2b: overlapping 181px, 4 arrows sharing an end point
  it("login flow", async () => {
    const result = await report("login", loginFlow);
    expect(result.shapeOverlaps).toBe(0);
    expect(result.arrowsThroughShapes).toBe(0);
    expect(result.labelsOnLines).toBe(0);
    // only the short common trunk where "Sim"/"Não" leave a diamond's tip
    expect(result.overlappingArrowLength).toBeLessThan(120);
    // organizing again changes nothing
    expect(result.secondRunMove).toBe(0);
  });

  // fase 2 as committed: 1517px of arrows on top of each other, 12 sharing
  // an end point, 1 label on a line, a second run still moved shapes 923px
  it("big flow (19 shapes, loops, there-and-back pairs)", async () => {
    const result = await report("big", bigFlow);
    expect(result).toEqual({
      overlappingArrowLength: 0,
      arrowsThroughShapes: 0,
      labelsOnLines: 0,
      sharedEndpoints: 0,
      shapeOverlaps: 0,
      secondRunMove: 0,
    });
  });
});
