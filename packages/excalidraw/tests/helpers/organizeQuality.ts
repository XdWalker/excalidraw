/**
 * Diagram fixtures and readability metrics for the "Organizar" action
 * (fork ia-local, fase 2b).
 */
import { pointFrom } from "@excalidraw/math";

import {
  convertToExcalidrawElements,
  LinearElementEditor,
  Scene,
} from "@excalidraw/element";

import type { LocalPoint } from "@excalidraw/math";

import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElementWithContainer,
} from "@excalidraw/element/types";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";

type NodeSpec = [
  id: string,
  type: "rectangle" | "diamond" | "ellipse",
  text: string,
  x: number,
  y: number,
];
type EdgeSpec = [source: string, target: string, label?: string];

const SIZE = {
  rectangle: [170, 60],
  diamond: [190, 110],
  ellipse: [170, 70],
} as const;

const skeletonFrom = (
  nodes: NodeSpec[],
  edges: EdgeSpec[],
): ExcalidrawElementSkeleton[] => {
  const center = (id: string) => {
    const [, type, , x, y] = nodes.find((node) => node[0] === id)!;
    return { x: x + SIZE[type][0] / 2, y: y + SIZE[type][1] / 2 };
  };
  return [
    ...nodes.map(([id, type, text, x, y]) => ({
      type,
      id,
      x,
      y,
      width: SIZE[type][0],
      height: SIZE[type][1],
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

/** login flow: 7 shapes, 2 decisions, 1 loop (the manual test of fase 2) */
export const loginFlow = () =>
  skeletonFrom(
    [
      ["ini", "rectangle", "Início", 820, 40],
      ["dig", "rectangle", "Digitar e-mail e senha", 80, 520],
      ["cred", "diamond", "Credenciais válidas?", 600, 300],
      ["erro", "rectangle", "Mostrar erro", 1050, 600],
      ["fa", "diamond", "2FA ativo?", 150, 120],
      ["cod", "rectangle", "Pedir código", 560, 700],
      ["painel", "ellipse", "Abrir painel", 1100, 250],
    ],
    [
      ["ini", "dig"],
      ["dig", "cred"],
      ["cred", "erro", "Não"],
      ["erro", "dig"],
      ["cred", "fa", "Sim"],
      ["fa", "cod", "Sim"],
      ["fa", "painel", "Não"],
      ["cod", "painel"],
    ],
  );

/**
 * The same structure as the big diagram tested by hand in Firefox after
 * fase 2 (19 shapes, 2 loops back to an earlier step, 2 there-and-back
 * pairs, labelled arrows), with neutral labels, scattered around.
 */
export const bigFlow = () =>
  skeletonFrom(
    [
      ["n1", "rectangle", "Receber pedido", 300, 900],
      ["n2", "rectangle", "Validar pedido", 1100, 80],
      ["n3", "rectangle", "Separar itens", 60, 420],
      ["n4", "rectangle", "Conferir qualidade", 900, 650],
      ["n5", "rectangle", "Enviar ao centro", 450, 60],
      ["n6", "rectangle", "Refazer separação", 1300, 500],
      ["n7", "rectangle", "Envio expresso", 120, 60],
      ["n8", "rectangle", "Envio padrão", 700, 380],
      ["n9", "rectangle", "Trocar transportadora", 1250, 950],
      ["n10", "rectangle", "Rastrear entrega", 380, 560],
      ["n11", "rectangle", "Trocar motorista", 60, 780],
      ["n12", "rectangle", "Retirada na loja", 1000, 1100],
      ["n13", "rectangle", "Confirmar recebimento", 650, 1000],
      ["n14", "rectangle", "Agendar entrega", 1350, 250],
      ["n15", "rectangle", "Emitir nota fiscal", 500, 760],
      ["n16", "rectangle", "Pesquisa de satisfação", 850, 200],
      ["n17", "rectangle", "Fidelizar cliente", 200, 1150],
      ["n18", "rectangle", "Abrir devolução", 1450, 750],
      ["n19", "rectangle", "Pedido concluído", 650, 1250],
    ],
    [
      ["n1", "n2"],
      ["n2", "n3"],
      ["n3", "n4"],
      ["n4", "n5"],
      ["n4", "n6", "Falha na conferência"],
      ["n6", "n2"],
      ["n5", "n7"],
      ["n5", "n8"],
      ["n5", "n9", "Atraso"],
      ["n9", "n5"],
      ["n7", "n10"],
      ["n7", "n11", "Veículo quebrado"],
      ["n11", "n7"],
      ["n7", "n12"],
      ["n10", "n13"],
      ["n8", "n14"],
      ["n13", "n15"],
      ["n14", "n15"],
      ["n15", "n16"],
      ["n16", "n17"],
      ["n17", "n19"],
      ["n15", "n18", "Reclamação"],
      ["n18", "n2"],
      ["n12", "n19"],
    ],
  );

export const sceneFrom = (skeleton: ExcalidrawElementSkeleton[]) =>
  new Scene(convertToExcalidrawElements(skeleton, { regenerateIds: false }), {
    skipValidation: true,
  });

type P = { x: number; y: number };

const isShape = (element: ExcalidrawElement) =>
  !element.isDeleted &&
  ["rectangle", "diamond", "ellipse"].includes(element.type);

const arrowPath = (arrow: ExcalidrawArrowElement): P[] =>
  arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }));

const segmentsOf = (path: P[]) =>
  path.slice(1).map((point, i) => [path[i], point] as const);

const insideBox = (p: P, box: ExcalidrawElement, inset: number) =>
  p.x > box.x + inset &&
  p.x < box.x + box.width - inset &&
  p.y > box.y + inset &&
  p.y < box.y + box.height - inset;

const sample = (a: P, b: P, steps = 40) =>
  Array.from({ length: steps + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / steps,
    y: a.y + ((b.y - a.y) * i) / steps,
  }));

/** length of the stretch where two axis-aligned segments run on top of each other */
const overlapLength = (
  [a1, a2]: readonly [P, P],
  [b1, b2]: readonly [P, P],
  tolerance = 3,
) => {
  const horizontal = (p: P, q: P) => Math.abs(p.y - q.y) < 0.5;
  const vertical = (p: P, q: P) => Math.abs(p.x - q.x) < 0.5;
  if (
    horizontal(a1, a2) &&
    horizontal(b1, b2) &&
    Math.abs(a1.y - b1.y) < tolerance
  ) {
    const lo = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x));
    const hi = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
    return Math.max(0, hi - lo);
  }
  if (
    vertical(a1, a2) &&
    vertical(b1, b2) &&
    Math.abs(a1.x - b1.x) < tolerance
  ) {
    const lo = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
    const hi = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
    return Math.max(0, hi - lo);
  }
  return 0;
};

export type OrganizeQuality = {
  /** px of arrow running on top of another arrow */
  overlappingArrowLength: number;
  /** arrow segments passing through a shape that isn't one of its ends */
  arrowsThroughShapes: number;
  /** labels covering a shape or another arrow's line */
  labelsOnLines: number;
  /** arrows arriving where another arrow arrives/leaves (within 12px) */
  sharedEndpoints: number;
  /** shape overlaps */
  shapeOverlaps: number;
};

export const measureOrganizeQuality = (scene: Scene): OrganizeQuality => {
  const elements = scene.getNonDeletedElements();
  const elementsMap = scene.getNonDeletedElementsMap();
  const shapes = elements.filter(isShape);
  const arrows = elements.filter(
    (element) => element.type === "arrow",
  ) as ExcalidrawArrowElement[];
  const paths = new Map(arrows.map((arrow) => [arrow.id, arrowPath(arrow)]));

  let overlappingArrowLength = 0;
  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      for (const a of segmentsOf(paths.get(arrows[i].id)!)) {
        for (const b of segmentsOf(paths.get(arrows[j].id)!)) {
          overlappingArrowLength += overlapLength(a, b);
        }
      }
    }
  }

  let arrowsThroughShapes = 0;
  for (const arrow of arrows) {
    const ends = [arrow.startBinding?.elementId, arrow.endBinding?.elementId];
    for (const shape of shapes) {
      if (ends.includes(shape.id)) {
        continue;
      }
      if (
        segmentsOf(paths.get(arrow.id)!).some(([a, b]) =>
          sample(a, b).some((p) => insideBox(p, shape, 4)),
        )
      ) {
        arrowsThroughShapes++;
      }
    }
  }

  let labelsOnLines = 0;
  for (const arrow of arrows) {
    const label = elements.find(
      (element) =>
        element.type === "text" &&
        (element as ExcalidrawTextElementWithContainer).containerId ===
          arrow.id,
    ) as ExcalidrawTextElementWithContainer | undefined;
    if (!label) {
      continue;
    }
    const { x, y } = LinearElementEditor.getBoundTextElementPosition(
      arrow,
      label,
      elementsMap,
    );
    const box = {
      x,
      y,
      width: label.width,
      height: label.height,
    } as ExcalidrawElement;
    const onShape = shapes.some(
      (shape) =>
        box.x < shape.x + shape.width &&
        shape.x < box.x + box.width &&
        box.y < shape.y + shape.height &&
        shape.y < box.y + box.height,
    );
    const onOtherArrow = arrows.some(
      (other) =>
        other.id !== arrow.id &&
        segmentsOf(paths.get(other.id)!).some(([a, b]) =>
          sample(a, b).some((p) => insideBox(p, box, 1)),
        ),
    );
    if (onShape || onOtherArrow) {
      labelsOnLines++;
    }
  }

  let sharedEndpoints = 0;
  for (const arrow of arrows) {
    const path = paths.get(arrow.id)!;
    const end = path[path.length - 1];
    const crowded = arrows.some((other) => {
      if (other.id === arrow.id) {
        return false;
      }
      const otherPath = paths.get(other.id)!;
      return [otherPath[0], otherPath[otherPath.length - 1]].some(
        (p) => Math.hypot(p.x - end.x, p.y - end.y) < 12,
      );
    });
    if (crowded) {
      sharedEndpoints++;
    }
  }

  let shapeOverlaps = 0;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      ) {
        shapeOverlaps++;
      }
    }
  }

  return {
    overlappingArrowLength: Math.round(overlappingArrowLength),
    arrowsThroughShapes,
    labelsOnLines,
    sharedEndpoints,
    shapeOverlaps,
  };
};

export const shapePositions = (scene: Scene) =>
  new Map(
    scene
      .getNonDeletedElements()
      .filter(isShape)
      .map((shape) => [shape.id, { x: shape.x, y: shape.y }]),
  );
