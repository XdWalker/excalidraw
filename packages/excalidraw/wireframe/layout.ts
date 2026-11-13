/**
 * Turns a `Wireframe` tree into Excalidraw element skeletons (fork ia-local,
 * fase 3). All positions and sizes are computed here, never by the LLM:
 * widths flow top-down, heights bottom-up, with a fixed style per block kind.
 */
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type { LocalPoint } from "@excalidraw/math";

import type {
  Wireframe,
  WireframeContainerKind,
  WireframeNode,
} from "./wireframe";

export const WIREFRAME_PAGE_WIDTH = 1200;

const COLORS = {
  ink: "#1e1e1e",
  muted: "#495057",
  placeholder: "#868e96",
  link: "#1971c2",
  border: "#adb5bd",
  band: "#e9ecef",
  soft: "#f1f3f5",
  image: "#dee2e6",
  button: "#a5d8ff",
  white: "#ffffff",
};

type Direction = "row" | "column" | "grid";

type ContainerStyle = {
  direction: Direction;
  padding: number;
  gap: number;
  /** spread a row's children over the whole width (logo left, button right) */
  spread?: boolean;
  /** center the children (hero) */
  center?: boolean;
  minHeight?: number;
  fill?: string;
  border?: "solid" | "dashed";
  rounded?: boolean;
  /** fixed width when inside a row (sidebar) */
  width?: number;
  /** caps the width when inside a column (forms read badly when too wide) */
  maxWidth?: number;
  /** font size of the container's own label, drawn as its title */
  titleSize?: number;
};

const CONTAINER_STYLE: Record<WireframeContainerKind, ContainerStyle> = {
  page: { direction: "column", padding: 24, gap: 24 },
  header: {
    direction: "row",
    padding: 16,
    gap: 24,
    spread: true,
    fill: COLORS.band,
    minHeight: 64,
  },
  nav: { direction: "row", padding: 0, gap: 24 },
  hero: {
    direction: "column",
    padding: 40,
    gap: 16,
    center: true,
    minHeight: 220,
    fill: COLORS.soft,
    titleSize: 34,
  },
  section: { direction: "column", padding: 0, gap: 16, titleSize: 24 },
  row: { direction: "row", padding: 0, gap: 16 },
  column: { direction: "column", padding: 0, gap: 12 },
  grid: { direction: "grid", padding: 0, gap: 20 },
  card: {
    direction: "column",
    padding: 16,
    gap: 10,
    border: "solid",
    rounded: true,
    titleSize: 18,
  },
  sidebar: {
    direction: "column",
    padding: 16,
    gap: 12,
    fill: COLORS.soft,
    width: 240,
    titleSize: 18,
  },
  footer: {
    direction: "row",
    padding: 16,
    gap: 24,
    fill: COLORS.band,
  },
  form: {
    direction: "column",
    padding: 20,
    gap: 12,
    border: "dashed",
    rounded: true,
    maxWidth: 460,
    titleSize: 20,
  },
  list: { direction: "column", padding: 0, gap: 8, titleSize: 18 },
};

const FONT = { text: 16, heading: 26, button: 16 };
const LINE_HEIGHT = 1.25;
/** rough average glyph width / font size of Excalidraw's hand-drawn font */
const CHAR_WIDTH = 0.58;
const CONTROL_HEIGHT = 40;
/** a column whose widest child is narrower than this share is centered */
const NARROW_BLOCK = 0.7;

/**
 * Where the page's top-left corner goes. Not (0, 0): the skeleton converter
 * treats a frame at x/y 0 as "no position" and shrinks it around its children.
 */
export const WIREFRAME_ORIGIN = { x: 100, y: 100 };

const textWidth = (text: string, fontSize: number) =>
  Math.ceil(text.length * fontSize * CHAR_WIDTH);

/** naive word wrap so long texts don't run out of their box */
const wrap = (text: string, fontSize: number, maxWidth: number) => {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * CHAR_WIDTH)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maxChars) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
};

const isContainer = (
  node: WireframeNode,
): node is WireframeNode & {
  kind: WireframeContainerKind;
} => node.kind in CONTAINER_STYLE;

type Size = { width: number; height: number };

type Context = {
  out: ExcalidrawElementSkeleton[] | null;
  nextId: () => string;
  /** inside a grid cell or card, images are thumbnails */
  compact: boolean;
  /** inside a header/nav/footer bar, an image is a logo */
  bar: boolean;
};

/**
 * The children a container actually lays out: its label becomes a title at
 * the top, except for containers that have no visible title of their own
 * (page, header, nav, row, column, grid, footer: there the label is usually
 * just "Header"/"Rodapé") or whose first child already says the same.
 */
const childrenOf = (node: WireframeNode): WireframeNode[] => {
  const children = node.children ?? [];
  if (!isContainer(node) || !node.label) {
    return children;
  }
  const style = CONTAINER_STYLE[node.kind];
  if (!style.titleSize) {
    return children;
  }
  // models often name a card "Toyota" and start it with a "Toyota" heading
  const first = children[0];
  if (
    first &&
    !isContainer(first) &&
    first.label?.trim().toLowerCase() === node.label.trim().toLowerCase()
  ) {
    return children;
  }
  return [
    { kind: "heading", label: node.label, fontSize: style.titleSize },
    ...children,
  ];
};

/** width a leaf wants when laid out in a row */
const leafNaturalWidth = (node: WireframeNode, ctx: Context): number => {
  const label = node.label ?? "";
  switch (node.kind) {
    case "heading":
      return textWidth(label, node.fontSize ?? FONT.heading);
    case "text":
    case "link":
      return textWidth(label, node.fontSize ?? FONT.text);
    case "button":
      return Math.max(100, textWidth(label, FONT.button) + 40);
    case "input":
      return 220;
    case "image":
      return ctx.bar ? LOGO.width : ctx.compact ? 160 : 220;
    case "table":
    case "chart":
      return 360;
    case "options":
      return optionsOf(label).reduce(
        (sum, option) => sum + optionWidth(option) + OPTION_GAP,
        -OPTION_GAP,
      );
    default:
      return 120;
  }
};

const emit = (ctx: Context, skeleton: ExcalidrawElementSkeleton) => {
  ctx.out?.push(skeleton);
};

const LOGO = { width: 120, height: 40 };
const TABLE = { rowHeight: 34, rows: 4, maxColumns: 6 };

const emitLine = (
  ctx: Context,
  x: number,
  y: number,
  dx: number,
  dy: number,
  strokeColor = COLORS.border,
) =>
  emit(ctx, {
    type: "line",
    id: ctx.nextId(),
    x,
    y,
    points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(dx, dy)],
    strokeColor,
  });

/**
 * A table: header row + a few empty rows. When the label lists the columns
 * ("Pedidos: ID, Cliente, Valor, Status" or "ID, Cliente, Valor"), they
 * become the header cells.
 */
const layoutTable = (
  label: string,
  x: number,
  y: number,
  available: number,
  ctx: Context,
): Size => {
  const list = label.includes(":")
    ? label.split(":").slice(1).join(":")
    : label;
  const columns = list.includes(",")
    ? list
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean)
        .slice(0, TABLE.maxColumns)
    : [];
  const count = columns.length || 4;
  const width = available;
  const height = TABLE.rowHeight * (TABLE.rows + 1);
  const cell = width / count;

  emit(ctx, {
    type: "rectangle",
    id: ctx.nextId(),
    x,
    y,
    width,
    height,
    backgroundColor: COLORS.white,
    fillStyle: "solid",
    strokeColor: COLORS.border,
  });
  emit(ctx, {
    type: "rectangle",
    id: ctx.nextId(),
    x,
    y,
    width,
    height: TABLE.rowHeight,
    backgroundColor: COLORS.band,
    fillStyle: "solid",
    strokeColor: COLORS.border,
  });
  for (let row = 2; row <= TABLE.rows; row++) {
    emitLine(ctx, x, y + row * TABLE.rowHeight, width, 0);
  }
  for (let column = 1; column < count; column++) {
    emitLine(ctx, x + column * cell, y, 0, height);
  }
  columns.forEach((column, i) =>
    emit(ctx, {
      type: "text",
      id: ctx.nextId(),
      x: x + i * cell + 8,
      y: y + (TABLE.rowHeight - FONT.text * LINE_HEIGHT) / 2,
      text: wrap(column, FONT.text, cell - 16)[0],
      fontSize: FONT.text,
      strokeColor: COLORS.ink,
    }),
  );
  if (!columns.length && label) {
    emit(ctx, {
      type: "text",
      id: ctx.nextId(),
      x: x + 8,
      y: y + (TABLE.rowHeight - FONT.text * LINE_HEIGHT) / 2,
      text: wrap(label, FONT.text, width - 16)[0],
      fontSize: FONT.text,
      strokeColor: COLORS.ink,
    });
  }
  return { width, height };
};

const OPTION_GAP = 8;
const OPTION_HEIGHT = 36;

const optionsOf = (label: string) => {
  const list = label.includes(":")
    ? label.split(":").slice(1).join(":")
    : label;
  const options = list
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
  return options.length ? options : ["Opção 1", "Opção 2", "Opção 3"];
};

const optionWidth = (option: string) =>
  Math.max(44, textWidth(option, FONT.text) + 24);

/**
 * A group of choices (sizes, colors, filters): small outlined buttons in a
 * row, wrapping when needed, the first one selected.
 */
const layoutOptions = (
  label: string,
  x: number,
  y: number,
  available: number,
  ctx: Context,
): Size => {
  let cursorX = x;
  let cursorY = y;
  let width = 0;
  optionsOf(label).forEach((option, i) => {
    const optionW = Math.min(optionWidth(option), available);
    if (cursorX > x && cursorX + optionW > x + available) {
      cursorX = x;
      cursorY += OPTION_HEIGHT + OPTION_GAP;
    }
    emit(ctx, {
      type: "rectangle",
      id: ctx.nextId(),
      x: cursorX,
      y: cursorY,
      width: optionW,
      height: OPTION_HEIGHT,
      backgroundColor: i === 0 ? COLORS.button : COLORS.white,
      fillStyle: "solid",
      roundness: { type: 3 },
      label: { text: option, fontSize: FONT.text },
    });
    cursorX += optionW + OPTION_GAP;
    width = Math.max(width, cursorX - OPTION_GAP - x);
  });
  return { width, height: cursorY + OPTION_HEIGHT - y };
};

/** A chart placeholder: axes and a line going up and down, with a caption. */
const layoutChart = (
  label: string,
  x: number,
  y: number,
  available: number,
  ctx: Context,
): Size => {
  const width = available;
  const height = Math.round(
    Math.min(Math.max(width * (ctx.compact ? 0.6 : 0.35), 140), 280),
  );
  emit(ctx, {
    type: "rectangle",
    id: ctx.nextId(),
    x,
    y,
    width,
    height,
    backgroundColor: COLORS.white,
    fillStyle: "solid",
    strokeColor: COLORS.border,
    roundness: { type: 3 },
  });
  const left = x + 24;
  const bottom = y + height - 20;
  const top = y + (label ? 40 : 20);
  const plotWidth = width - 48;
  emitLine(ctx, left, top, 0, bottom - top);
  emitLine(ctx, left, bottom, plotWidth, 0);
  const shape = [0.2, 0.55, 0.35, 0.75, 0.5, 0.9];
  emit(ctx, {
    type: "line",
    id: ctx.nextId(),
    x: left,
    y: bottom - shape[0] * (bottom - top),
    points: shape.map((value, i) =>
      pointFrom<LocalPoint>(
        (plotWidth / (shape.length - 1)) * i,
        (shape[0] - value) * (bottom - top),
      ),
    ),
    strokeColor: COLORS.link,
    strokeWidth: 2,
  });
  if (label) {
    emit(ctx, {
      type: "text",
      id: ctx.nextId(),
      x: x + 16,
      y: y + 10,
      text: wrap(label, FONT.text, width - 32)[0],
      fontSize: FONT.text,
      strokeColor: COLORS.muted,
    });
  }
  return { width, height };
};

const layoutLeaf = (
  node: WireframeNode,
  x: number,
  y: number,
  available: number,
  ctx: Context,
): Size => {
  const label = node.label ?? "";
  switch (node.kind) {
    case "heading":
    case "text":
    case "link": {
      const fontSize =
        node.fontSize ?? (node.kind === "heading" ? FONT.heading : FONT.text);
      const lines = wrap(label || "Texto", fontSize, available);
      const width = Math.min(
        available,
        Math.max(...lines.map((line) => textWidth(line, fontSize))),
      );
      const height = Math.ceil(lines.length * fontSize * LINE_HEIGHT);
      emit(ctx, {
        type: "text",
        id: ctx.nextId(),
        x,
        y,
        text: lines.join("\n"),
        fontSize,
        strokeColor:
          node.kind === "link"
            ? COLORS.link
            : node.kind === "text"
            ? COLORS.muted
            : COLORS.ink,
      });
      return { width, height };
    }
    case "button": {
      const width = Math.min(available, leafNaturalWidth(node, ctx));
      emit(ctx, {
        type: "rectangle",
        id: ctx.nextId(),
        x,
        y,
        width,
        height: CONTROL_HEIGHT,
        backgroundColor: COLORS.button,
        fillStyle: "solid",
        roundness: { type: 3 },
        label: { text: label || "Botão", fontSize: FONT.button },
      });
      return { width, height: CONTROL_HEIGHT };
    }
    case "input": {
      const width = Math.min(available, 480);
      emit(ctx, {
        type: "rectangle",
        id: ctx.nextId(),
        x,
        y,
        width,
        height: CONTROL_HEIGHT,
        backgroundColor: COLORS.white,
        fillStyle: "solid",
        label: {
          text: label || "Campo",
          fontSize: FONT.text,
          textAlign: "left",
          strokeColor: COLORS.placeholder,
        },
      });
      return { width, height: CONTROL_HEIGHT };
    }
    case "table":
      return layoutTable(label, x, y, available, ctx);
    case "options":
      return layoutOptions(label, x, y, available, ctx);
    case "chart":
      return layoutChart(label, x, y, available, ctx);
    case "image": {
      const width = ctx.bar ? Math.min(available, LOGO.width) : available;
      const height = Math.round(
        ctx.bar
          ? LOGO.height
          : ctx.compact
          ? Math.min(Math.max(width * 0.6, 90), 200)
          : Math.min(Math.max(width * 0.4, 140), 320),
      );
      emit(ctx, {
        type: "rectangle",
        id: ctx.nextId(),
        x,
        y,
        width,
        height,
        backgroundColor: COLORS.image,
        fillStyle: "solid",
        strokeColor: COLORS.border,
        ...(label
          ? {
              label: {
                text: label,
                fontSize: 14,
                // a logo shows just its name; a picture its caption below
                verticalAlign: ctx.bar ? "middle" : "bottom",
                strokeColor: COLORS.muted,
              },
            }
          : {}),
      });
      // the classic "image placeholder" cross (not on a small logo, where it
      // would cover the name)
      for (const [from, to] of ctx.bar && label
        ? []
        : [
            [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(width, height)],
            [
              pointFrom<LocalPoint>(width, 0),
              pointFrom<LocalPoint>(-width, height),
            ],
          ]) {
        emit(ctx, {
          type: "line",
          id: ctx.nextId(),
          x: x + from[0],
          y: y + from[1],
          points: [pointFrom<LocalPoint>(0, 0), to],
          strokeColor: COLORS.border,
        });
      }
      return { width, height };
    }
    default:
      return { width: 0, height: 0 };
  }
};

/**
 * Lays a node out at (x, y) within `available` width and returns its size.
 * With `ctx.out === null` it only measures.
 */
const layoutNode = (
  node: WireframeNode,
  x: number,
  y: number,
  available: number,
  ctx: Context,
): Size => {
  if (!isContainer(node)) {
    return layoutLeaf(node, x, y, available, ctx);
  }

  const style = CONTAINER_STYLE[node.kind];
  const children = childrenOf(node);
  // an empty block (the model sometimes leaves one) isn't drawn at all
  if (!children.length && node.kind !== "page" && !node.minHeight) {
    return { width: 0, height: 0 };
  }
  const width =
    style.maxWidth && node.kind !== "page"
      ? Math.min(available, style.maxWidth)
      : available;
  const inner = width - style.padding * 2;
  const compact = ctx.compact || node.kind === "card" || node.kind === "grid";
  const bar =
    ctx.bar ||
    node.kind === "header" ||
    node.kind === "nav" ||
    node.kind === "footer";

  // background first, so it's behind the children (its height is known only
  // after measuring them)
  const measureCtx: Context = { ...ctx, out: null, compact, bar };
  const contentHeight = layoutChildren(
    node,
    style,
    children,
    0,
    0,
    inner,
    measureCtx,
  );
  const height = Math.max(
    style.minHeight ?? 0,
    node.minHeight ?? 0,
    contentHeight + style.padding * 2,
  );

  if (style.fill || style.border) {
    emit(ctx, {
      type: "rectangle",
      id: ctx.nextId(),
      x,
      y,
      width,
      height,
      backgroundColor: style.fill ?? "transparent",
      fillStyle: "solid",
      strokeColor: style.border ? COLORS.border : style.fill ?? COLORS.border,
      strokeStyle: style.border === "dashed" ? "dashed" : "solid",
      roundness: style.rounded ? { type: 3 } : null,
    });
  }

  const offsetY =
    style.center && height > contentHeight + style.padding * 2
      ? (height - contentHeight - style.padding * 2) / 2
      : 0;
  layoutChildren(
    node,
    style,
    children,
    x + style.padding,
    y + style.padding + offsetY,
    inner,
    { ...ctx, compact, bar },
  );

  return { width, height };
};

const layoutChildren = (
  node: WireframeNode,
  style: ContainerStyle,
  children: WireframeNode[],
  x: number,
  y: number,
  width: number,
  ctx: Context,
): number => {
  if (!children.length) {
    return 0;
  }

  if (node.kind === "page" && children.some((c) => c.kind === "sidebar")) {
    return layoutPageWithSidebar(style, children, x, y, width, ctx);
  }

  if (style.direction === "grid") {
    return layoutGrid(node, style, children, x, y, width, ctx);
  }

  if (style.direction === "row") {
    return layoutRow(node, style, children, x, y, width, ctx);
  }

  // column
  const measured = children.map((child) =>
    layoutNode(child, 0, 0, width, { ...ctx, out: null }),
  );
  // a column of narrow things (a login form and a link) is centered as a
  // block instead of hugging the left edge of a wide page
  const widest = Math.max(...measured.map((size) => size.width));
  const blockX =
    !style.center &&
    (node.kind === "page" || node.kind === "section") &&
    widest < width * NARROW_BLOCK
      ? x + (width - widest) / 2
      : x;

  let cursor = y;
  children.forEach((child, i) => {
    const childX = style.center ? x + (width - measured[i].width) / 2 : blockX;
    const size = layoutNode(child, childX, cursor, width, ctx);
    cursor += size.height + style.gap;
  });
  return cursor - style.gap - y;
};

/**
 * Leaves keep their natural width; containers share what's left. Wraps to a
 * new line when it doesn't fit. A spread row (header, footer) pushes its
 * items apart to fill the width.
 */
const layoutRow = (
  node: WireframeNode,
  style: ContainerStyle,
  children: WireframeNode[],
  x: number,
  y: number,
  width: number,
  ctx: Context,
): number => {
  const fixed = (child: WireframeNode) =>
    isContainer(child)
      ? CONTAINER_STYLE[child.kind].width ?? null
      : leafNaturalWidth(child, ctx);

  const fixedTotal = children.reduce((sum, c) => sum + (fixed(c) ?? 0), 0);
  const flexible = children.filter((c) => fixed(c) === null).length;
  const gaps = style.gap * (children.length - 1);
  const flexWidth = flexible
    ? Math.max(160, (width - fixedTotal - gaps) / flexible)
    : 0;

  const widths = children.map((c) => Math.min(width, fixed(c) ?? flexWidth));

  // split into lines
  const lines: number[][] = [];
  let current: number[] = [];
  let used = 0;
  widths.forEach((w, i) => {
    const needed = current.length ? used + style.gap + w : w;
    if (current.length && needed > width) {
      lines.push(current);
      current = [i];
      used = w;
    } else {
      current.push(i);
      used = needed;
    }
  });
  if (current.length) {
    lines.push(current);
  }

  let cursorY = y;
  for (const line of lines) {
    const sizes = line.map((i) =>
      layoutNode(children[i], 0, 0, widths[i], { ...ctx, out: null }),
    );
    const lineHeight = Math.max(...sizes.map((s) => s.height));
    const lineWidth =
      sizes.reduce((sum, s) => sum + s.width, 0) +
      style.gap * (line.length - 1);
    const extraGap =
      style.spread && line.length > 1
        ? (width - lineWidth) / (line.length - 1)
        : 0;

    // a sidebar runs along the whole line, next to the content
    const hasSidebar = line.some((i) => children[i].kind === "sidebar");

    const lineTop = cursorY;
    let cursorX = x;
    line.forEach((i, j) => {
      const child =
        children[i].kind === "sidebar"
          ? { ...children[i], minHeight: lineHeight }
          : children[i];
      // vertically centered in the line (or top-aligned: sidebar + content)
      const top =
        node.alignTop || hasSidebar
          ? lineTop
          : lineTop + (lineHeight - sizes[j].height) / 2;
      layoutNode(child, cursorX, top, widths[i], ctx);
      cursorX += sizes[j].width + style.gap + extraGap;
    });
    cursorY += lineHeight + style.gap;
  }
  return cursorY - style.gap - y;
};

const layoutGrid = (
  node: WireframeNode,
  style: ContainerStyle,
  children: WireframeNode[],
  x: number,
  y: number,
  width: number,
  ctx: Context,
): number => {
  const columns = Math.max(
    1,
    Math.min(node.columns ?? Math.min(children.length, 3), children.length),
  );
  const cell = (width - style.gap * (columns - 1)) / columns;
  let cursorY = y;
  for (let start = 0; start < children.length; start += columns) {
    const row = children.slice(start, start + columns);
    const heights = row.map(
      (child) => layoutNode(child, 0, 0, cell, { ...ctx, out: null }).height,
    );
    const rowHeight = Math.max(...heights);
    const rowTop = cursorY;
    row.forEach((child, i) => {
      layoutNode(child, x + i * (cell + style.gap), rowTop, cell, ctx);
    });
    cursorY += rowHeight + style.gap;
  }
  return cursorY - style.gap - y;
};

/**
 * header(s) on top, footer(s) at the bottom, and in between the sidebar(s),
 * as tall as the main content, next to it (wherever the model put them).
 */
const layoutPageWithSidebar = (
  style: ContainerStyle,
  children: WireframeNode[],
  x: number,
  y: number,
  width: number,
  ctx: Context,
): number => {
  const headers = children.filter((c) => c.kind === "header");
  const footers = children.filter((c) => c.kind === "footer");
  const sidebars = children.filter((c) => c.kind === "sidebar");
  const main: WireframeNode = {
    kind: "column",
    children: children.filter(
      (c) => c.kind !== "header" && c.kind !== "footer" && c.kind !== "sidebar",
    ),
  };

  // the sidebar runs from the header to the footer, next to the content
  const rowStyle = CONTAINER_STYLE.row;
  const sidebarWidth =
    sidebars.length * ((CONTAINER_STYLE.sidebar.width ?? 0) + rowStyle.gap);
  const mainHeight = layoutNode(main, 0, 0, width - sidebarWidth, {
    ...ctx,
    out: null,
  }).height;

  const restructured: WireframeNode[] = [
    ...headers,
    {
      kind: "row",
      alignTop: true,
      children: [
        ...sidebars.map((sidebar) => ({ ...sidebar, minHeight: mainHeight })),
        main,
      ],
    },
    ...footers,
  ];
  return layoutChildren(
    { kind: "section" },
    { ...style, direction: "column" },
    restructured,
    x,
    y,
    width,
    ctx,
  );
};

/**
 * Elements for a wireframe, inside a frame named after its title, with the
 * frame's top-left corner at `WIREFRAME_ORIGIN`.
 */
export const layoutWireframe = (
  wireframe: Wireframe,
  { width = WIREFRAME_PAGE_WIDTH }: { width?: number } = {},
): ExcalidrawElementSkeleton[] => {
  let counter = 0;
  const out: ExcalidrawElementSkeleton[] = [];
  const ctx: Context = {
    out,
    nextId: () => `wireframe-${++counter}`,
    compact: false,
    bar: false,
  };

  const { x, y } = WIREFRAME_ORIGIN;
  const size = layoutNode(
    { ...wireframe.root, kind: "page" },
    x,
    y,
    width,
    ctx,
  );

  out.push({
    type: "frame",
    id: "wireframe-frame",
    name: wireframe.title,
    x,
    y,
    width: size.width,
    height: size.height,
    children: out.map((element) => element.id!).filter(Boolean),
  });

  return out;
};
