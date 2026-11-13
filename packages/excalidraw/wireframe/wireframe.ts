/**
 * Wireframe (fork ia-local, fase 3): a UI screen described as a tree of
 * blocks of a fixed set of kinds. An LLM produces only this structure (no
 * positions or sizes, which small models get wrong); `layoutWireframe`
 * turns it into Excalidraw elements.
 */

export const WIREFRAME_CONTAINER_KINDS = [
  "page",
  "header",
  "nav",
  "hero",
  "section",
  "row",
  "column",
  "grid",
  "card",
  "sidebar",
  "footer",
  "form",
  "list",
] as const;

export const WIREFRAME_LEAF_KINDS = [
  "heading",
  "text",
  "button",
  "input",
  "image",
  "link",
  "table",
  "chart",
  "options",
] as const;

export const WIREFRAME_KINDS = [
  ...WIREFRAME_CONTAINER_KINDS,
  ...WIREFRAME_LEAF_KINDS,
] as const;

export type WireframeContainerKind = typeof WIREFRAME_CONTAINER_KINDS[number];
export type WireframeLeafKind = typeof WIREFRAME_LEAF_KINDS[number];
export type WireframeKind = typeof WIREFRAME_KINDS[number];

export type WireframeNode = {
  kind: WireframeKind;
  label?: string;
  /** grid only: number of columns */
  columns?: number;
  children?: WireframeNode[];
  /** internal (layout only, never from the model): a title's font size */
  fontSize?: number;
  /** internal (layout only): stretch to at least this height (sidebar) */
  minHeight?: number;
  /** internal (layout only): row children aligned to the top */
  alignTop?: boolean;
};

export type Wireframe = {
  title: string;
  root: WireframeNode;
};

export const WIREFRAME_LIMITS = {
  depth: 6,
  children: 12,
  columns: 6,
  /** paragraphs need room; titles are cut to `title` */
  label: 400,
  title: 80,
  nodes: 150,
};

const isContainerKind = (kind: WireframeKind) =>
  (WIREFRAME_CONTAINER_KINDS as readonly string[]).includes(kind);

const nodeSchema = (depth: number): Record<string, unknown> => {
  const properties: Record<string, unknown> = {
    kind: { type: "string", enum: WIREFRAME_KINDS.filter((k) => k !== "page") },
    label: { type: "string" },
    columns: {
      type: "integer",
      minimum: 1,
      maximum: WIREFRAME_LIMITS.columns,
    },
  };
  if (depth > 0) {
    properties.children = {
      type: "array",
      items: nodeSchema(depth - 1),
      maxItems: WIREFRAME_LIMITS.children,
    };
  }
  return {
    type: "object",
    properties,
    required: ["kind"],
    additionalProperties: false,
  };
};

/**
 * JSON schema for OpenAI-compatible `response_format: { type: "json_schema" }`
 * (llama.cpp, Ollama, LM Studio turn it into a grammar, so the model can only
 * produce valid structure). Nesting is unrolled to a fixed depth because not
 * every server supports recursive `$ref`s.
 */
export const WIREFRAME_JSON_SCHEMA = {
  name: "wireframe",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      root: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["page"] },
          label: { type: "string" },
          children: {
            type: "array",
            items: nodeSchema(WIREFRAME_LIMITS.depth - 1),
            maxItems: WIREFRAME_LIMITS.children,
          },
        },
        required: ["kind", "children"],
        additionalProperties: false,
      },
    },
    required: ["title", "root"],
    additionalProperties: false,
  },
} as const;

export class WireframeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireframeParseError";
  }
}

/**
 * Validates and normalizes what the model returned: unknown kinds become a
 * generic section (container) or text (leaf), labels are trimmed, children
 * of leaves are dropped, and depth/size limits are enforced so a runaway
 * answer can't produce a huge drawing.
 */
export const parseWireframe = (input: unknown): Wireframe => {
  let data = input;
  if (typeof data === "string") {
    const json = data
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      data = JSON.parse(json);
    } catch {
      throw new WireframeParseError("not valid JSON");
    }
  }
  if (!data || typeof data !== "object") {
    throw new WireframeParseError("not an object");
  }

  const raw = data as { title?: unknown; root?: unknown };
  // tolerate a bare tree without the { title, root } wrapper
  const rawRoot = raw.root ?? (("kind" in raw && raw) || null);
  if (!rawRoot || typeof rawRoot !== "object") {
    throw new WireframeParseError("missing root");
  }

  let count = 0;
  const normalize = (node: unknown, depth: number): WireframeNode | null => {
    if (!node || typeof node !== "object" || count >= WIREFRAME_LIMITS.nodes) {
      return null;
    }
    count++;
    const value = node as Record<string, unknown>;
    const rawChildren = Array.isArray(value.children) ? value.children : [];
    let kind = String(value.kind ?? "").toLowerCase() as WireframeKind;
    if (!(WIREFRAME_KINDS as readonly string[]).includes(kind)) {
      kind = rawChildren.length ? "section" : "text";
    }
    const label =
      typeof value.label === "string"
        ? value.label.trim().slice(0, WIREFRAME_LIMITS.label)
        : undefined;
    const result: WireframeNode = { kind };
    if (label) {
      result.label = label;
    }
    if (kind === "grid") {
      const columns = Number(value.columns);
      result.columns = Number.isFinite(columns)
        ? Math.min(Math.max(Math.round(columns), 1), WIREFRAME_LIMITS.columns)
        : undefined;
    }
    if (isContainerKind(kind) && depth < WIREFRAME_LIMITS.depth) {
      const children = rawChildren
        .slice(0, WIREFRAME_LIMITS.children)
        .map((child) => normalize(child, depth + 1))
        .filter((child): child is WireframeNode => !!child);
      if (children.length) {
        result.children = children;
      }
    }
    return result;
  };

  const root = normalize(rawRoot, 0);
  if (!root) {
    throw new WireframeParseError("empty root");
  }
  root.kind = "page";

  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, WIREFRAME_LIMITS.title)
      : root.label || "Wireframe";

  return { title, root };
};
