/**
 * Demonstração da Fase 5 ("Limpar rascunho") sem mesa digitalizadora: monta
 * no app (modo de desenvolvimento, `window.h`) um fluxograma "desenhado à
 * mão" — formas em um traço, setas com a ponta à parte e palavras escritas
 * como traços da fonte Hershey (traço único, domínio público; o arquivo
 * hersheytext.min.json vem do pacote npm `hersheytext`, MIT).
 *
 *   const demo = await import("/@fs/<repo>/ia-local/demo/sketchDemo.js");
 *   await demo.drawSketch("/models/_teste/hersheytext.min.json");
 *   await demo.cleanUp();   // seleciona tudo e roda "Limpar rascunho"
 */

const moduleUrl = (pattern) =>
  performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .find((name) => pattern.test(name));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let wobbleState = 7;
const wobble = (amount) => {
  wobbleState = (wobbleState * 1664525 + 1013904223) % 4294967296;
  return (wobbleState / 4294967296 - 0.5) * amount;
};

const freedraw = (element, points) => {
  const [x0, y0] = points[0];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    ...element.newFreeDrawElement({
      type: "freedraw",
      x: x0,
      y: y0,
      simulatePressure: true,
      strokeWidth: 2,
      points: points.map(([x, y]) => [x - x0, y - y0]),
    }),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const along = (from, to, steps, amount) =>
  Array.from({ length: steps }, (_, i) => [
    from[0] + ((to[0] - from[0]) * i) / steps + wobble(amount),
    from[1] + ((to[1] - from[1]) * i) / steps + wobble(amount),
  ]);

const polygon = (corners) => {
  const points = [];
  for (let i = 0; i < corners.length - 1; i++) {
    points.push(...along(corners[i], corners[i + 1], 16, 3));
  }
  points.push([corners[0][0] + 4, corners[0][1] + 2]);
  return points;
};

const rect = (x, y, w, h) =>
  polygon([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ]);

const diamond = (x, y, w, h) =>
  polygon([
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
    [x + w / 2, y],
  ]);

const ellipse = (x, y, w, h) =>
  Array.from({ length: 64 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2;
    return [
      x + w / 2 + (w / 2) * Math.cos(a) + wobble(3),
      y + h / 2 + (h / 2) * Math.sin(a) + wobble(3),
    ];
  });

const arrowParts = (from, to) => {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const wing = (side) => [
    to[0] - 18 * Math.cos(angle + side * 0.5),
    to[1] - 18 * Math.sin(angle + side * 0.5),
  ];
  return [
    [...along(from, to, 30, 2), to],
    [wing(1), to, wing(-1)],
  ];
};

/** text -> strokes, Hershey single-stroke font, `height` px tall */
const handwriting = (font, text, x, y, height) => {
  const scale = height / 21;
  const strokes = [];
  let cursor = x;
  for (const char of text) {
    if (char === " ") {
      cursor += 10 * scale;
      continue;
    }
    const glyph = font.chars[char.charCodeAt(0) - 33];
    if (!glyph) {
      continue;
    }
    const glyphStrokes = glyph.d
      .split("M")
      .filter(Boolean)
      .map((part) =>
        part
          .replace("L", " ")
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(",").map(Number)),
      );
    const minX = Math.min(...glyphStrokes.flat().map((p) => p[0]));
    const maxX = Math.max(...glyphStrokes.flat().map((p) => p[0]));
    for (const points of glyphStrokes) {
      if (points.length < 2) {
        continue;
      }
      strokes.push(
        // eslint-disable-next-line no-loop-func -- runs right away, inside the loop
        points.map(([gx, gy]) => [
          cursor + (gx - minX) * scale + wobble(1),
          y + gy * scale + wobble(1),
        ]),
      );
    }
    cursor += (maxX - minX + 5) * scale;
  }
  return strokes;
};

export const drawSketch = async (fontUrl, fontName = "futural") => {
  const element = await import(
    moduleUrl(/\/packages\/element\/src\/index\.ts/)
  );
  const font = (await (await fetch(fontUrl)).json())[fontName];
  const strokes = [
    rect(100, 100, 240, 100),
    diamond(90, 300, 260, 170),
    rect(520, 335, 220, 100),
    ellipse(120, 590, 220, 100),
    ...arrowParts([220, 210], [220, 292]),
    ...arrowParts([360, 385], [510, 385]),
    ...arrowParts([220, 478], [220, 582]),
    ...handwriting(font, "Inicio", 160, 132, 30),
    ...handwriting(font, "Pagou?", 160, 368, 30),
    ...handwriting(font, "Enviar", 565, 368, 30),
    ...handwriting(font, "Fim", 195, 625, 30),
    ...handwriting(font, "Sim", 405, 338, 24),
    ...handwriting(font, "Nao", 240, 515, 24),
    ...handwriting(font, "revisar depois", 520, 140, 24),
  ].map((points) => freedraw(element, points));
  window.h.app.updateScene({ elements: strokes, captureUpdate: "IMMEDIATELY" });
  await sleep(300);
  return strokes.length;
};

export const cleanUp = async () => {
  const { h } = window;
  h.setState({
    selectedElementIds: Object.fromEntries(
      h.app.scene.getNonDeletedElements().map((e) => [e.id, true]),
    ),
  });
  await sleep(300);
  const started = performance.now();
  h.app.actionManager.executeAction(
    h.app.actionManager.actions.cleanSketch,
    "commandPalette",
  );
  const before = h.app.scene.getNonDeletedElements().length;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (
      h.app.scene.getNonDeletedElements().some((e) => e.type !== "freedraw")
    ) {
      break;
    }
  }
  await sleep(500);
  return {
    seconds: (performance.now() - started) / 1000,
    before,
    after: h.app.scene
      .getNonDeletedElements()
      .map((e) => (e.type === "text" ? `text:${e.text}` : e.type)),
    toast: h.state.toast?.message ?? null,
  };
};
