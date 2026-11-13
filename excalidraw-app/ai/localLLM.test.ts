import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseWireframe,
  WIREFRAME_JSON_SCHEMA,
} from "@excalidraw/excalidraw/wireframe/wireframe";

import {
  createMermaidStreamSanitizer,
  fixFlowchartShapes,
  loadLocalLLMConfig,
  LOCAL_LLM_STORAGE_KEY,
  localLLMStreamFetch,
  localLLMWireframeFetch,
  MERMAID_SYSTEM_PROMPT,
  normalizeBaseURL,
  sanitizeMermaidResponse,
  saveLocalLLMConfig,
  WIREFRAME_SYSTEM_PROMPT,
} from "./localLLM";

const encoder = new TextEncoder();

/** SSE no formato OpenAI (llama.cpp / Ollama / LM Studio) */
const sseStream = (deltas: string[], { done = true } = {}) => {
  const events = deltas.map(
    (delta) =>
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: delta } }],
      })}\n\n`,
  );
  if (done) {
    events.push("data: [DONE]\n\n");
  }
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) {
        // quebra cada evento em dois pedaços de rede, como acontece de verdade
        const event = events[index++];
        const half = Math.floor(event.length / 2);
        controller.enqueue(encoder.encode(event.slice(0, half)));
        controller.enqueue(encoder.encode(event.slice(half)));
      } else {
        controller.close();
      }
    },
  });
};

const okResponse = (deltas: string[]) =>
  new Response(sseStream(deltas), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const config = { baseURL: "http://127.0.0.1:9931/v1", model: "qwen" };
const messages = [{ role: "user" as const, content: "fluxo de login" }];

describe("sanitizeMermaidResponse", () => {
  it("removes markdown fences", () => {
    expect(
      sanitizeMermaidResponse("```mermaid\nflowchart TD\n  A --> B\n```\n"),
    ).toBe("flowchart TD\n  A --> B");
  });

  it("drops text after the closing fence", () => {
    expect(
      sanitizeMermaidResponse(
        "```\nflowchart TD\nA-->B\n```\nEspero ter ajudado!",
      ),
    ).toBe("flowchart TD\nA-->B");
  });

  it("removes a leading <think> block", () => {
    expect(
      sanitizeMermaidResponse(
        "<think>pensando...</think>\n\nflowchart TD\nA-->B",
      ),
    ).toBe("flowchart TD\nA-->B");
  });

  it("keeps plain Mermaid untouched", () => {
    expect(sanitizeMermaidResponse("sequenceDiagram\n  A->>B: oi")).toBe(
      "sequenceDiagram\n  A->>B: oi",
    );
  });

  it("holds back possible markers while streaming", () => {
    expect(sanitizeMermaidResponse("``", false)).toBe("");
    expect(sanitizeMermaidResponse("<thi", false)).toBe("");
    expect(sanitizeMermaidResponse("<think>ainda pensando", false)).toBe("");
    expect(sanitizeMermaidResponse("```mermaid", false)).toBe("");
    expect(sanitizeMermaidResponse("flowchart TD\nA-->B\n`", false)).toBe(
      "flowchart TD\nA-->B\n",
    );
  });

  it("emits only complete lines while streaming", () => {
    expect(sanitizeMermaidResponse('flowchart TD\nA --> B["Pag', false)).toBe(
      "flowchart TD\n",
    );
  });

  it("fixes mismatched shape brackets in flowcharts", () => {
    expect(
      sanitizeMermaidResponse(
        'flowchart TD\n  G -- "Sim" --> H["Cliente satisfeito?"}\n  H -- "Não" --> G',
      ),
    ).toBe(
      'flowchart TD\n  G -- "Sim" --> H{"Cliente satisfeito?"}\n  H -- "Não" --> G',
    );
  });

  it("leaves other diagram types alone", () => {
    const sequence = 'sequenceDiagram\n  A->>B: texto ["x"}';
    expect(sanitizeMermaidResponse(sequence)).toBe(sequence);
  });
});

describe("fixFlowchartShapes", () => {
  it.each([
    ['H["Satisfeito?"}', 'H{"Satisfeito?"}'],
    ['C{"Aprovado?"]', 'C{"Aprovado?"}'],
    ['A["Passo")', 'A["Passo"]'],
    ['A("Passo"]', 'A("Passo")'],
    ['B["Pagamento aprovado?"]', 'B{"Pagamento aprovado?"}'],
    ['B("Tem estoque? "]', 'B{"Tem estoque? "}'],
  ])("%s -> %s", (input, output) => {
    expect(fixFlowchartShapes(input)).toBe(output);
  });

  it.each([
    'A["Passo"] --> B{"Decisão?"}',
    'A(["Início"]) --> B[["Sub"]]',
    'A -- "Sim" --> B',
    "A[Sem aspas} --> B",
  ])("keeps valid or unquoted shapes: %s", (line) => {
    expect(fixFlowchartShapes(line)).toBe(line);
  });
});

describe("createMermaidStreamSanitizer", () => {
  it("fixes a broken decision line before it is shown", () => {
    const sanitizer = createMermaidStreamSanitizer();
    const pieces = [
      "flowchart TD\n",
      'A --> B["Pago?',
      '"}\n',
      'B --> C["Fim"]',
    ];
    const emitted = pieces.map((piece) => sanitizer.push(piece)).join("");
    const { delta, text } = sanitizer.finish();
    expect(emitted + delta).toBe(
      'flowchart TD\nA --> B{"Pago?"}\nB --> C["Fim"]',
    );
    expect(text).toBe('flowchart TD\nA --> B{"Pago?"}\nB --> C["Fim"]');
  });

  it("emits only clean, append-only deltas", () => {
    const sanitizer = createMermaidStreamSanitizer();
    const pieces = [
      "``",
      "`mer",
      "maid\nflow",
      "chart TD\n",
      "A-->B\n",
      "``",
      "`\n",
    ];
    const emitted = pieces.map((piece) => sanitizer.push(piece)).join("");
    const { delta, text } = sanitizer.finish();
    expect(emitted + delta).toBe("flowchart TD\nA-->B\n");
    expect(text).toBe("flowchart TD\nA-->B");
  });
});

describe("normalizeBaseURL", () => {
  it("accepts a full chat/completions URL or a trailing slash", () => {
    expect(normalizeBaseURL(" http://127.0.0.1:8080/v1/ ")).toBe(
      "http://127.0.0.1:8080/v1",
    );
    expect(normalizeBaseURL("http://127.0.0.1:8080/v1/chat/completions")).toBe(
      "http://127.0.0.1:8080/v1",
    );
  });
});

describe("local LLM config", () => {
  beforeEach(() => localStorage.removeItem(LOCAL_LLM_STORAGE_KEY));

  it("persists the config in localStorage", () => {
    saveLocalLLMConfig({ baseURL: "http://localhost:1234/v1/", model: "x" });
    expect(loadLocalLLMConfig()).toEqual({
      baseURL: "http://localhost:1234/v1",
      model: "x",
    });
  });

  it("falls back to the default when storage is corrupt", () => {
    localStorage.setItem(LOCAL_LLM_STORAGE_KEY, "{oops");
    expect(loadLocalLLMConfig().baseURL).toMatch(/^http/);
  });
});

describe("localLLMStreamFetch", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("streams OpenAI-style chunks and returns clean Mermaid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse(["```mermaid\n", "flowchart TD\n", "  A --> B\n", "```"]),
      );
    global.fetch = fetchMock;
    const chunks: string[] = [];
    const onStreamCreated = vi.fn();

    const result = await localLLMStreamFetch({
      config,
      messages,
      onChunk: (chunk) => chunks.push(chunk),
      onStreamCreated,
    });

    expect(result).toEqual({
      generatedResponse: "flowchart TD\n  A --> B",
      error: null,
    });
    expect(chunks.join("").trim()).toBe("flowchart TD\n  A --> B");
    expect(onStreamCreated).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9931/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen");
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: MERMAID_SYSTEM_PROMPT,
    });
    expect(body.messages.slice(1)).toEqual(messages);
  });

  it("uses the first listed model when none is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "llama3.2:3b" }] })),
      )
      .mockResolvedValueOnce(okResponse(["flowchart TD\nA-->B"]));
    global.fetch = fetchMock;

    const result = await localLLMStreamFetch({
      config: { ...config, model: "" },
      messages,
    });

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9931/v1/models");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe(
      "llama3.2:3b",
    );
    expect(result.error).toBeNull();
  });

  it("returns a friendly error when the server is not running", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("NetworkError when attempting to fetch"),
      );

    const result = await localLLMStreamFetch({ config, messages });

    expect(result.error?.status).toBe(503);
    expect(result.error?.message).toContain("http://127.0.0.1:9931/v1");
  });

  it("reports HTTP errors from the server", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
      }),
    );

    const result = await localLLMStreamFetch({ config, messages });

    expect(result.error?.status).toBe(404);
    expect(result.error?.message).toContain("model not found");
  });

  it("never reports a local error as the cloud rate limit (429)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("busy", { status: 429 }));

    const result = await localLLMStreamFetch({ config, messages });

    expect(result.error?.status).toBe(503);
  });

  it("returns an error for an empty response", async () => {
    global.fetch = vi.fn().mockResolvedValue(okResponse([]));

    const result = await localLLMStreamFetch({ config, messages });

    expect(result.error?.status).toBe(500);
  });

  it("reports an aborted request as aborted", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });

    const result = await localLLMStreamFetch({
      config,
      messages,
      signal: controller.signal,
    });

    expect(result.error?.status).toBe(499);
  });
});

describe("localLLMWireframeFetch", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const reply = (content: string) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
      }),
      { status: 200 },
    );

  const sample = {
    title: "Login",
    root: {
      kind: "page",
      children: [
        { kind: "form", children: [{ kind: "button", label: "Entrar" }] },
      ],
    },
  };

  it("asks for JSON constrained by the wireframe schema, without thinking", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(JSON.stringify(sample)));
    global.fetch = fetchMock;

    const result = await localLLMWireframeFetch({
      config,
      prompt: "tela de login",
    });

    expect(result.error).toBeNull();
    expect("wireframe" in result && result.wireframe.title).toBe("Login");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: WIREFRAME_JSON_SCHEMA,
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: WIREFRAME_SYSTEM_PROMPT,
    });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "tela de login",
    });
  });

  it("sends the current wireframe when asked for a change", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(JSON.stringify(sample)));
    global.fetch = fetchMock;
    const previous = parseWireframe(sample);

    await localLLMWireframeFetch({
      config,
      prompt: "adicione um rodapé",
      previous,
    });

    const userMessage = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1]
      .content as string;
    expect(userMessage).toContain(JSON.stringify(previous));
    expect(userMessage).toContain("adicione um rodapé");
  });

  it("reports an answer that isn't a wireframe", async () => {
    global.fetch = vi.fn().mockResolvedValue(reply("desculpe, não sei"));

    const result = await localLLMWireframeFetch({ config, prompt: "x tela" });

    expect(result.error?.status).toBe(500);
    expect(result.error?.message).toMatch(/wireframe/i);
  });

  it("returns a friendly error when the server is not running", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await localLLMWireframeFetch({ config, prompt: "x tela" });

    expect(result.error?.status).toBe(503);
    expect(result.error?.message).toContain("127.0.0.1:9931");
  });
});
