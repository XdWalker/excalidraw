import fs from "fs";
import path from "path";

import { convertToExcalidrawElements } from "@excalidraw/element";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";

import { Excalidraw, TTDDialog } from "../index";
import { layoutWireframe, WIREFRAME_ORIGIN } from "../wireframe/layout";
import {
  parseWireframe,
  WIREFRAME_JSON_SCHEMA,
  WIREFRAME_LIMITS,
  WireframeParseError,
} from "../wireframe/wireframe";

import { act, fireEvent, render, waitFor } from "./test-utils";

import type { Wireframe, WireframeNode } from "../wireframe/wireframe";

const { h } = window;

/** outputs of the local LLM recorded in fase 0 (ia-local/bench) */
const benchWireframe = (file: string) =>
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../ia-local/bench/saidas-sem-raciocinio",
      file,
    ),
    "utf8",
  );

type Box = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const boxesOf = (skeletons: ExcalidrawElementSkeleton[]): Box[] =>
  skeletons
    .filter((s) => s.type !== "frame" && s.type !== "line")
    .map((s: any) => ({
      id: s.id,
      type: s.type,
      x: s.x,
      y: s.y,
      w: s.width ?? 0,
      h: s.height ?? (s.type === "text" ? s.fontSize * 1.25 : 0),
    }));

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w - 1 &&
  b.x < a.x + a.w - 1 &&
  a.y < b.y + b.h - 1 &&
  b.y < a.y + a.h - 1;

/** buttons, inputs and images never overlap each other */
const controlOverlaps = (skeletons: ExcalidrawElementSkeleton[]) => {
  const controls = boxesOf(skeletons).filter(
    (box) =>
      box.type === "rectangle" &&
      skeletons.find((s) => s.id === box.id && "label" in s && s.label),
  );
  const found: string[] = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      if (overlap(controls[i], controls[j])) {
        found.push(`${controls[i].id}/${controls[j].id}`);
      }
    }
  }
  return found;
};

const frameOf = (skeletons: ExcalidrawElementSkeleton[]) =>
  skeletons.find((s) => s.type === "frame") as any;

describe("parseWireframe", () => {
  it("accepts the JSON the local model produced (fase 0)", () => {
    const wireframe = parseWireframe(benchWireframe("wf_login.off.json"));
    expect(wireframe.title).toBe("Login");
    expect(wireframe.root.kind).toBe("page");
    expect(wireframe.root.children?.map((c) => c.kind)).toEqual([
      "header",
      "section",
      "footer",
    ]);
  });

  it("forces the root to be a page and strips markdown fences", () => {
    const wireframe = parseWireframe(
      '```json\n{"title":"X","root":{"kind":"nav","children":[{"kind":"text","label":"a"}]}}\n```',
    );
    expect(wireframe.root.kind).toBe("page");
  });

  it("maps unknown kinds to a section (with children) or text (leaf)", () => {
    const wireframe = parseWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          { kind: "carousel", children: [{ kind: "image" }] },
          { kind: "badge", label: "Novo" },
        ],
      },
    });
    expect(wireframe.root.children?.map((c) => c.kind)).toEqual([
      "section",
      "text",
    ]);
  });

  it("drops children of leaves and enforces the limits", () => {
    const deep = (depth: number): unknown =>
      depth === 0
        ? { kind: "text", label: "x" }
        : { kind: "section", children: [deep(depth - 1)] };
    const wireframe = parseWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          { kind: "button", label: "Ok", children: [{ kind: "text" }] },
          {
            kind: "grid",
            columns: 99,
            children: Array.from({ length: 30 }, () => ({ kind: "card" })),
          },
          deep(20),
        ],
      },
    });
    const [button, grid, nested] = wireframe.root.children!;
    expect(button.children).toBeUndefined();
    expect(grid.columns).toBe(WIREFRAME_LIMITS.columns);
    expect(grid.children).toHaveLength(WIREFRAME_LIMITS.children);
    let depth = 0;
    let node: WireframeNode | undefined = nested;
    while (node?.children?.length) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBeLessThan(WIREFRAME_LIMITS.depth);
  });

  it("rejects what isn't a wireframe", () => {
    expect(() => parseWireframe("não é json")).toThrow(WireframeParseError);
    expect(() => parseWireframe({ title: "x" })).toThrow(WireframeParseError);
  });

  it("schema only allows the known kinds and a page at the root", () => {
    const root = WIREFRAME_JSON_SCHEMA.schema.properties.root;
    expect(root.properties.kind.enum).toEqual(["page"]);
    const child = root.properties.children.items as any;
    expect(child.properties.kind.enum).toContain("card");
    expect(child.properties.kind.enum).not.toContain("page");
  });
});

describe("layoutWireframe", () => {
  it("lays the cars home page (fase 0) out inside its frame", () => {
    const wireframe = parseWireframe(benchWireframe("wf_carros.off.json"));
    const skeletons = layoutWireframe(wireframe);
    const frame = frameOf(skeletons);

    expect(frame.name).toBe(wireframe.title);
    expect(frame.x).toBe(WIREFRAME_ORIGIN.x);
    expect(frame.children).toHaveLength(skeletons.length - 1);

    for (const box of boxesOf(skeletons)) {
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.y).toBeGreaterThanOrEqual(frame.y);
      expect(box.x + box.w).toBeLessThanOrEqual(frame.x + frame.width + 1);
      expect(box.y + box.h).toBeLessThanOrEqual(frame.y + frame.height + 1);
    }
    expect(controlOverlaps(skeletons)).toEqual([]);
  });

  it("puts grid items in columns", () => {
    const wireframe: Wireframe = {
      title: "Grade",
      root: {
        kind: "page",
        children: [
          {
            kind: "grid",
            columns: 3,
            children: Array.from({ length: 6 }, (_, i) => ({
              kind: "card",
              children: [{ kind: "button", label: `Item ${i}` }],
            })),
          },
        ],
      },
    };
    const skeletons = layoutWireframe(wireframe);
    const buttons = boxesOf(skeletons).filter((b) =>
      skeletons.find(
        (s: any) => s.id === b.id && s.label?.text?.startsWith("Item"),
      ),
    );
    expect(new Set(buttons.map((b) => Math.round(b.x))).size).toBe(3);
    expect(new Set(buttons.map((b) => Math.round(b.y))).size).toBe(2);
    expect(controlOverlaps(skeletons)).toEqual([]);
  });

  it("puts a sidebar next to the main content, under the header", () => {
    const wireframe: Wireframe = {
      title: "Painel",
      root: {
        kind: "page",
        children: [
          { kind: "header", children: [{ kind: "text", label: "Logo" }] },
          { kind: "sidebar", children: [{ kind: "link", label: "Início" }] },
          { kind: "section", children: [{ kind: "button", label: "Salvar" }] },
          { kind: "footer", children: [{ kind: "text", label: "©" }] },
        ],
      },
    };
    const skeletons = layoutWireframe(wireframe) as any[];
    const text = (label: string) =>
      skeletons.find((s) => s.text === label || s.label?.text === label);
    const logo = text("Logo");
    const link = text("Início");
    const save = text("Salvar");
    const footer = text("©");
    expect(link.x).toBeLessThan(save.x);
    expect(link.y).toBeGreaterThan(logo.y);
    expect(Math.abs(link.y - save.y)).toBeLessThan(60);
    expect(footer.y).toBeGreaterThan(save.y);
  });

  it("stretches the sidebar along the content, below the header", () => {
    const skeletons = layoutWireframe({
      title: "Painel",
      root: {
        kind: "page",
        children: [
          // the model put the sidebar before the header
          { kind: "sidebar", children: [{ kind: "link", label: "Pedidos" }] },
          { kind: "header", children: [{ kind: "button", label: "Sair" }] },
          {
            kind: "section",
            children: [
              { kind: "chart", label: "Vendas" },
              { kind: "table", label: "ID, Cliente, Valor" },
            ],
          },
        ],
      },
    }) as any[];
    const exit = skeletons.find((s) => s.label?.text === "Sair");
    const link = skeletons.find((s) => s.text === "Pedidos");
    const sidebarBox = skeletons.find(
      (s) =>
        s.type === "rectangle" &&
        s.x <= link.x &&
        s.y <= link.y &&
        s.width === 240,
    );
    const table = skeletons.find((s) => s.text === "Valor");
    expect(exit.y).toBeLessThan(link.y);
    expect(sidebarBox).toBeDefined();
    // as tall as the content next to it, down to the table
    expect(sidebarBox.y + sidebarBox.height).toBeGreaterThan(table.y);
  });

  it("stretches a sidebar the model put in a row", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          {
            kind: "row",
            children: [
              { kind: "sidebar", children: [{ kind: "link", label: "Menu" }] },
              {
                kind: "column",
                children: [{ kind: "table", label: "A, B" }, { kind: "chart" }],
              },
            ],
          },
        ],
      },
    }) as any[];
    const sidebar = skeletons.find(
      (s) => s.type === "rectangle" && s.width === 240,
    );
    const table = skeletons.find((s) => s.text === "A");
    expect(sidebar.y).toBeLessThanOrEqual(table.y);
    const bottom = Math.max(
      ...skeletons
        .filter((s) => s.type === "rectangle" && s !== sidebar)
        .map((s) => s.y + s.height),
    );
    expect(sidebar.y + sidebar.height).toBeGreaterThanOrEqual(bottom - 1);
  });

  it("draws a table with the listed columns and a chart", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          { kind: "table", label: "Pedidos: ID, Cliente, Valor, Status" },
          { kind: "chart", label: "Vendas por mês" },
        ],
      },
    }) as any[];
    const texts = skeletons.filter((s) => s.type === "text").map((s) => s.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        "ID",
        "Cliente",
        "Valor",
        "Status",
        "Vendas por mês",
      ]),
    );
    expect(
      skeletons.some((s) => s.type === "line" && s.points.length > 3),
    ).toBe(true);
  });

  it("draws options as a row of small buttons, the first one selected", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [{ kind: "options", label: "Tamanho: 38, 39, 40, 41" }],
      },
    }) as any[];
    const options = skeletons.filter((s) =>
      ["38", "39", "40", "41"].includes(s.label?.text),
    );
    expect(options).toHaveLength(4);
    expect(new Set(options.map((o) => o.y)).size).toBe(1);
    expect(options[0].backgroundColor).not.toBe(options[1].backgroundColor);
    expect(controlOverlaps(skeletons)).toEqual([]);
  });

  it("doesn't draw empty blocks", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          { kind: "section", label: "Avaliações" },
          { kind: "grid", children: [{ kind: "card" }] },
          { kind: "button", label: "Ok" },
        ],
      },
    }) as any[];
    // the section keeps its title; the empty grid/card draw nothing
    expect(skeletons.filter((s) => s.type === "rectangle")).toHaveLength(1);
    expect(skeletons.some((s) => s.text === "Avaliações")).toBe(true);
  });

  it("draws an image in a header as a small logo", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          { kind: "header", children: [{ kind: "image", label: "Logo" }] },
        ],
      },
    }) as any[];
    const logo = skeletons.find((s) => s.label?.text === "Logo");
    expect(logo.height).toBeLessThanOrEqual(40);
  });

  it("does not repeat a card's name when its first line already says it", () => {
    const skeletons = layoutWireframe({
      title: "T",
      root: {
        kind: "page",
        children: [
          {
            kind: "card",
            label: "Toyota",
            children: [{ kind: "heading", label: "Toyota" }],
          },
        ],
      },
    }) as any[];
    expect(skeletons.filter((s) => s.text === "Toyota")).toHaveLength(1);
  });

  it("converts into Excalidraw elements inside a frame", () => {
    const skeletons = layoutWireframe(
      parseWireframe(benchWireframe("wf_login.off.json")),
    );
    const elements = convertToExcalidrawElements(skeletons, {
      regenerateIds: true,
    });
    const frame = elements.find((element) => element.type === "frame")!;
    expect(frame.x).toBe(WIREFRAME_ORIGIN.x);
    expect(
      elements.filter((element) => element.id !== frame.id && !element.frameId),
    ).toEqual([]);
  });
});

describe("Wireframe tab", () => {
  const wireframe = parseWireframe(benchWireframe("wf_login.off.json"));

  it("generates from a request, refines it and inserts it", async () => {
    const onWireframeSubmit = vi
      .fn()
      .mockResolvedValue({ wireframe, error: null });

    await render(
      <Excalidraw
        initialData={{
          appState: { openDialog: { name: "ttd", tab: "wireframe" } },
        }}
      >
        <TTDDialog
          onTextSubmit={async () => ({ generatedResponse: "", error: null })}
          onWireframeSubmit={onWireframeSubmit}
          persistenceAdapter={{
            loadChats: async () => [],
            saveChats: async () => {},
          }}
        />
      </Excalidraw>,
    );

    const dialog = document.querySelector(".ttd-dialog")!;
    const input = () =>
      dialog.querySelector<HTMLTextAreaElement>(".ttd-dialog-wireframe-input")!;
    const button = (label: string) =>
      [...dialog.querySelectorAll<HTMLElement>("button")].find((b) =>
        b.textContent?.includes(label),
      )!;

    fireEvent.change(input(), { target: { value: "Tela de login de banco" } });
    await act(async () => {
      fireEvent.click(button("Generate wireframe"));
    });

    expect(onWireframeSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Tela de login de banco",
        previous: null,
      }),
    );
    await waitFor(() => expect(dialog.querySelector("canvas")).not.toBeNull());

    // a second request is a change to the current wireframe
    fireEvent.change(input(), { target: { value: "adicione um rodapé" } });
    await act(async () => {
      fireEvent.click(button("Apply change"));
    });
    expect(onWireframeSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "adicione um rodapé",
        previous: wireframe,
      }),
    );

    await act(async () => {
      fireEvent.click(button("Insert"));
    });
    await waitFor(() =>
      expect(h.elements.some((element) => element.type === "frame")).toBe(true),
    );
    expect(h.state.openDialog).toBe(null);
  });

  it("shows the error the host returns", async () => {
    await render(
      <Excalidraw
        initialData={{
          appState: { openDialog: { name: "ttd", tab: "wireframe" } },
        }}
      >
        <TTDDialog
          onTextSubmit={async () => ({ generatedResponse: "", error: null })}
          onWireframeSubmit={async () => ({
            error: new Error("servidor fora do ar"),
          })}
          persistenceAdapter={{
            loadChats: async () => [],
            saveChats: async () => {},
          }}
        />
      </Excalidraw>,
    );
    const dialog = document.querySelector(".ttd-dialog")!;
    fireEvent.change(dialog.querySelector(".ttd-dialog-wireframe-input")!, {
      target: { value: "qualquer tela" },
    });
    await act(async () => {
      fireEvent.click(
        [...dialog.querySelectorAll<HTMLElement>("button")].find((b) =>
          b.textContent?.includes("Generate wireframe"),
        )!,
      );
    });
    await waitFor(() =>
      expect(
        dialog.querySelector('[data-testid="wireframe-error"]')?.textContent,
      ).toContain("servidor fora do ar"),
    );
  });
});
