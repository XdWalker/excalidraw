/**
 * Demonstração da Fase 2 ("Organizar"), para rodar no console do navegador
 * com o app em modo de desenvolvimento (yarn start), onde `window.h` existe:
 *
 *   const demo = await import("/@fs/<caminho do repo>/ia-local/demo/organizeDemo.js");
 *   await demo.messyLogin();          // desenha um fluxograma de login bagunçado
 *   await demo.organize("organizeElementsTopToBottom");
 *
 * `organize` aceita "organizeElements" (direção automática),
 * "organizeElementsTopToBottom" ou "organizeElementsLeftToRight".
 * `snapshot(nome, url)` exporta o desenho em PNG e envia por POST para `url`
 * (usado para registrar os prints de antes e depois).
 */

const moduleUrl = (pattern) => {
  const url = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .find((name) => pattern.test(name));
  if (!url) {
    throw new Error(`módulo não carregado: ${pattern}`);
  }
  return url;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NODES = [
  ["ini", "rectangle", "Início", 820, 40],
  ["dig", "rectangle", "Digitar e-mail e senha", 80, 520],
  ["cred", "diamond", "Credenciais válidas?", 600, 300],
  ["erro", "rectangle", "Mostrar erro", 1050, 600],
  ["fa", "diamond", "2FA ativo?", 150, 120],
  ["cod", "rectangle", "Pedir código", 560, 700],
  ["painel", "ellipse", "Abrir painel", 1100, 250],
];

const EDGES = [
  ["ini", "dig"],
  ["dig", "cred"],
  ["cred", "erro", "Não"],
  ["erro", "dig"],
  ["cred", "fa", "Sim"],
  ["fa", "cod", "Sim"],
  ["fa", "painel", "Não"],
  ["cod", "painel"],
];

const SIZE = { rectangle: [170, 70], diamond: [190, 110], ellipse: [170, 80] };

export const messyLogin = async () => {
  const element = await import(
    moduleUrl(/\/packages\/element\/src\/index\.ts/)
  );
  const box = Object.fromEntries(
    NODES.map(([id, type, , x, y]) => [
      id,
      { x, y, w: SIZE[type][0], h: SIZE[type][1] },
    ]),
  );
  const skeleton = NODES.map(([id, type, text, x, y]) => ({
    type,
    id,
    x,
    y,
    width: SIZE[type][0],
    height: SIZE[type][1],
    label: { text },
  }));
  EDGES.forEach(([source, target, label], index) => {
    const a = box[source];
    const b = box[target];
    const x = a.x + a.w / 2;
    const y = a.y + a.h / 2;
    skeleton.push({
      type: "arrow",
      id: `e${index}`,
      x,
      y,
      points: [
        [0, 0],
        [b.x + b.w / 2 - x, b.y + b.h / 2 - y],
      ],
      start: { id: source },
      end: { id: target },
      ...(label ? { label: { text: label } } : {}),
    });
  });
  window.h.app.updateScene({
    elements: element.convertToExcalidrawElements(skeleton, {
      regenerateIds: false,
    }),
    captureUpdate: "IMMEDIATELY",
  });
  await sleep(300);
};

export const selectAll = async () => {
  const { h } = window;
  h.setState({
    selectedElementIds: Object.fromEntries(
      h.app.scene
        .getNonDeletedElements()
        .filter((element) => !element.containerId)
        .map((element) => [element.id, true]),
    ),
  });
  await sleep(300);
};

export const organize = async (action = "organizeElements") => {
  const { h } = window;
  await selectAll();
  h.app.actionManager.executeAction(
    h.app.actionManager.actions[action],
    "commandPalette",
  );
  await sleep(2000);
  h.setState({ selectedElementIds: {} });
  await sleep(300);
};

export const snapshot = async (name, url = "http://127.0.0.1:8765") => {
  const excalidraw = await import(
    moduleUrl(/\/packages\/excalidraw\/index\.tsx/)
  );
  const { h } = window;
  const blob = await excalidraw.exportScene({
    type: "png",
    data: {
      elements: h.app.scene.getNonDeletedElements(),
      appState: {
        ...h.state,
        exportBackground: true,
        viewBackgroundColor: "#ffffff",
        exportWithDarkMode: false,
      },
      files: h.app.files,
    },
    config: { padding: 30 },
  });
  const response = await fetch(`${url}/${name}`, {
    method: "POST",
    body: blob,
  });
  return response.status;
};
