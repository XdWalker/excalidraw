/**
 * Cliente da IA local (fork "ia-local").
 *
 * Fala com qualquer servidor compatível com a API de chat da OpenAI rodando
 * na máquina do usuário (llama.cpp `llama-server`, Ollama, LM Studio...),
 * direto do navegador, sem backend nem proxy. Nada sai da máquina.
 */
import { parseSSEStream } from "@excalidraw/excalidraw";
import { RequestError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";

import type {
  LLMMessage,
  TTTDDialog,
} from "@excalidraw/excalidraw/components/TTDDialog/types";

// -----------------------------------------------------------------------------
// configuração
// -----------------------------------------------------------------------------

export type LocalLLMConfig = {
  /** ex.: http://127.0.0.1:11434/v1 (Ollama) ou http://127.0.0.1:8080/v1 */
  baseURL: string;
  /** vazio = usar o primeiro modelo que o servidor listar */
  model: string;
};

export const LOCAL_LLM_STORAGE_KEY = "excalidraw-ia-local";

const FALLBACK_BASE_URL = "http://127.0.0.1:11434/v1";

export const normalizeBaseURL = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");

export const getDefaultLocalLLMConfig = (): LocalLLMConfig => ({
  baseURL: normalizeBaseURL(
    import.meta.env.VITE_APP_LOCAL_LLM_URL || FALLBACK_BASE_URL,
  ),
  model: import.meta.env.VITE_APP_LOCAL_LLM_MODEL || "",
});

export const loadLocalLLMConfig = (): LocalLLMConfig => {
  const defaults = getDefaultLocalLLMConfig();
  try {
    const saved = JSON.parse(
      localStorage.getItem(LOCAL_LLM_STORAGE_KEY) || "null",
    );
    if (saved && typeof saved === "object") {
      return {
        baseURL:
          typeof saved.baseURL === "string" && saved.baseURL.trim()
            ? normalizeBaseURL(saved.baseURL)
            : defaults.baseURL,
        model: typeof saved.model === "string" ? saved.model : defaults.model,
      };
    }
  } catch {
    // localStorage indisponível ou corrompido -> padrão
  }
  return defaults;
};

export const saveLocalLLMConfig = (config: LocalLLMConfig) => {
  try {
    localStorage.setItem(
      LOCAL_LLM_STORAGE_KEY,
      JSON.stringify({ ...config, baseURL: normalizeBaseURL(config.baseURL) }),
    );
  } catch {
    // sem localStorage (ex.: navegação privada restrita): vale só nesta sessão
  }
};

export const getHostLabel = (baseURL: string) => {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
};

// -----------------------------------------------------------------------------
// modelos disponíveis
// -----------------------------------------------------------------------------

export const fetchLocalLLMModels = async (
  baseURL: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const response = await fetch(`${normalizeBaseURL(baseURL)}/models`, {
    signal,
  });
  if (!response.ok) {
    throw new RequestError({
      message: `HTTP ${response.status}`,
      status: response.status,
    });
  }
  const json = await response.json();
  const list: unknown[] = Array.isArray(json?.data) ? json.data : [];
  return list
    .map((item: any) => (typeof item?.id === "string" ? item.id : null))
    .filter((id): id is string => !!id);
};

const resolveModel = async (config: LocalLLMConfig, signal?: AbortSignal) => {
  if (config.model) {
    return config.model;
  }
  const models = await fetchLocalLLMModels(config.baseURL, signal);
  if (!models.length) {
    throw new RequestError({
      message: t("localAI.errors.noModels"),
      status: 404,
    });
  }
  return models[0];
};

// -----------------------------------------------------------------------------
// prompt
// -----------------------------------------------------------------------------

// Versão da fase 1b. A comparação com a versão anterior (6 pedidos curtos, 2x
// cada) está em ia-local/README.md: decisões por fluxograma de ~1,9 para ~3,5.
export const MERMAID_SYSTEM_PROMPT = `You turn the user's request into ONE Mermaid diagram, drawn the way a domain expert would draw it.

Output rules:
- Reply with Mermaid code ONLY: no markdown fences, no explanations, no comments before or after.
- Pick the diagram type that fits: flowchart (processes, decisions), sequenceDiagram (messages between participants), classDiagram, stateDiagram-v2, erDiagram, gantt, timeline or quadrantChart. Prefer "flowchart TD" when unsure.
- Write every label in the same language as the user's request. Keep labels short (max ~6 words).

Content rules for processes (flowcharts and state diagrams):
- Model the process as it really happens, not only the happy path. Even when the request is short, include the decision points it naturally has (validations, approvals, availability checks, success or failure), what happens on each outcome, and loops back to an earlier step when something has to be retried or corrected.
- Every decision has at least two labelled exits (e.g. "Sim" / "Não"). Every path either reaches an end step or rejoins the flow: no dead ends.
- Aim for about 8 to 16 nodes. Draw a straight line only when the process truly has no choices.
- If the user describes the steps in detail, follow their description and do not invent extra steps.

Syntax rules:
- Flowcharts: wrap node and edge labels in double quotes, e.g. A["Validar usuário"] and A -- "Sim" --> B.
- Close every shape with the bracket that opened it: steps are A["..."], decisions are C{"..."}. Never write C["...?"}.
- Sequence diagrams: never put quotes in participant names; use an alias without spaces, e.g. "participant BD as Banco de Dados". Use alt/else blocks for alternative outcomes.
- When the user asks to change the previous diagram, reply with the full updated diagram.`;

// -----------------------------------------------------------------------------
// correções determinísticas de sintaxe
// -----------------------------------------------------------------------------

const MATCHING_CLOSER: Record<string, string> = {
  "[": "]",
  "(": ")",
  "{": "}",
};

/**
 * Conserta a forma dos nós de uma linha de fluxograma (erros vistos na fase
 * 1b). Só mexe em rótulos entre aspas e formas de um caractere ([ ], ( ), { }):
 * - colchetes trocados: `H["Cliente satisfeito?"}` vira `H{"Cliente satisfeito?"}`
 *   (se um dos lados é chave, vira decisão; senão fecha com o par de quem abriu);
 * - pergunta desenhada como passo: `B["Pagamento aprovado?"]` vira
 *   `B{"Pagamento aprovado?"}`, porque rótulo terminado em "?" é decisão.
 */
export const fixFlowchartShapes = (line: string) =>
  line.replace(
    /(\b[A-Za-z_][\w-]*)([[({])"([^"\n]*)"([\])}])/g,
    (match, id: string, open: string, label: string, close: string) => {
      if (open === "{" || close === "}" || label.trim().endsWith("?")) {
        return `${id}{"${label}"}`;
      }
      if (MATCHING_CLOSER[open] === close) {
        return match;
      }
      return `${id}${open}"${label}"${MATCHING_CLOSER[open]}`;
    },
  );

const isFlowchart = (text: string) =>
  /^\s*(flowchart|graph)\b/.test(text.trimStart());

const fixFlowchartLines = (text: string) =>
  isFlowchart(text)
    ? text.split("\n").map(fixFlowchartShapes).join("\n")
    : text;

// -----------------------------------------------------------------------------
// limpeza do texto em streaming
// -----------------------------------------------------------------------------

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const FENCE = "```";

/**
 * Remove o que não é Mermaid da resposta do modelo: bloco <think>...</think>
 * no início (modelos/servidores que não separam o raciocínio), a cerca
 * ```mermaid de abertura e a ``` de fechamento (e o que vier depois dela).
 *
 * `final = false` é usado durante o streaming: só linhas completas saem (a
 * última, ainda incompleta, fica retida), o que também segura qualquer coisa
 * que ainda possa virar uma dessas marcas.
 *
 * Em fluxogramas, cada linha completa passa por `fixFlowchartShapes`.
 */
export const sanitizeMermaidResponse = (raw: string, final = true) => {
  let text = raw.trimStart();

  if (text.startsWith(THINK_OPEN)) {
    const end = text.indexOf(THINK_CLOSE);
    if (end === -1) {
      return "";
    }
    text = text.slice(end + THINK_CLOSE.length).trimStart();
  } else if (!final && text && THINK_OPEN.startsWith(text)) {
    return "";
  }

  if (text.startsWith(FENCE)) {
    const newline = text.indexOf("\n");
    if (newline === -1) {
      return "";
    }
    text = text.slice(newline + 1);
  } else if (!final && text && FENCE.startsWith(text)) {
    return "";
  }

  const closingFence = text.search(/(^|\n)```/);
  if (closingFence !== -1) {
    text = text.slice(0, closingFence);
    // depois da cerca de fechamento não vem mais nada útil
    final = true;
  }

  if (final) {
    return fixFlowchartLines(text.trim());
  }

  // só linhas completas
  return fixFlowchartLines(text.slice(0, text.lastIndexOf("\n") + 1));
};

/**
 * Recebe os pedaços crus do modelo e devolve só os pedaços limpos que podem
 * ser mostrados. O texto mostrado nunca "volta atrás": o que já foi emitido
 * continua sendo prefixo do texto final.
 */
export const createMermaidStreamSanitizer = () => {
  let raw = "";
  let emitted = "";

  const emitUpTo = (clean: string) => {
    if (!clean.startsWith(emitted)) {
      return "";
    }
    const delta = clean.slice(emitted.length);
    emitted = clean;
    return delta;
  };

  return {
    push(chunk: string) {
      raw += chunk;
      return emitUpTo(sanitizeMermaidResponse(raw, false));
    },
    finish() {
      const delta = emitUpTo(sanitizeMermaidResponse(raw, true));
      return { delta, text: emitted.trim() };
    },
  };
};

// -----------------------------------------------------------------------------
// chamada ao servidor
// -----------------------------------------------------------------------------

const isAbortError = (error: any, signal?: AbortSignal) =>
  error?.name === "AbortError" || !!signal?.aborted;

const readErrorMessage = async (response: Response) => {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return json?.error?.message || json?.error || json?.message || text;
  } catch {
    return text;
  }
};

export type LocalLLMStreamOptions = TTTDDialog.OnTextSubmitProps & {
  config: LocalLLMConfig;
  systemPrompt?: string;
};

/**
 * Mesmo contrato do `TTDStreamFetch` original (usado pelo diálogo "Texto
 * para diagrama"), mas falando o formato OpenAI do servidor local.
 */
export const localLLMStreamFetch = async ({
  config,
  messages,
  onChunk,
  onStreamCreated,
  signal,
  systemPrompt = MERMAID_SYSTEM_PROMPT,
}: LocalLLMStreamOptions): Promise<TTTDDialog.OnTextSubmitRetValue> => {
  const baseURL = normalizeBaseURL(config.baseURL);

  try {
    const model = await resolveModel(config, signal);

    const llmMessages: (LLMMessage | { role: "system"; content: string })[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: llmMessages,
        stream: true,
        temperature: 0.3,
        max_tokens: 4096,
        // sem "raciocínio": a resposta sai 4-5x mais rápido e a qualidade
        // medida foi equivalente (ver ia-local/README.md, fase 0)
        chat_template_kwargs: { enable_thinking: false }, // llama.cpp
        reasoning_effort: "none", // Ollama
      }),
      signal,
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      return {
        error: new RequestError({
          message: t("localAI.errors.serverError", {
            status: response.status,
            message: String(message || "").slice(0, 300),
          }),
          status: response.status === 429 ? 503 : response.status,
        }),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        error: new RequestError({
          message: t("localAI.errors.generationFailed"),
          status: 500,
        }),
      };
    }

    onStreamCreated?.();

    const sanitizer = createMermaidStreamSanitizer();
    let streamError: RequestError | null = null;

    for await (const data of parseSSEStream(reader)) {
      if (data === "[DONE]") {
        break;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk?.error) {
        streamError = new RequestError({
          message: String(chunk.error.message || chunk.error),
          status: 500,
        });
        break;
      }
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        const clean = sanitizer.push(delta);
        if (clean) {
          onChunk?.(clean);
        }
      }
    }

    const { delta, text } = sanitizer.finish();
    if (delta) {
      onChunk?.(delta);
    }

    if (streamError) {
      return { error: streamError };
    }

    if (!text) {
      return {
        error: new RequestError({
          message: t("localAI.errors.generationFailed"),
          status: 500,
        }),
      };
    }

    return { generatedResponse: text, error: null };
  } catch (error: any) {
    if (isAbortError(error, signal)) {
      return {
        error: new RequestError({ message: "Aborted", status: 499 }),
      };
    }
    if (error instanceof RequestError) {
      return { error };
    }
    // fetch() rejeita com TypeError quando não há servidor na porta
    return {
      error: new RequestError({
        message: t("localAI.errors.unreachable", { url: baseURL }),
        status: 503,
      }),
    };
  }
};
