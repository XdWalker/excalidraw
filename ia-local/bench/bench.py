"""Fase 0: mede latência e validade de saída do LLM local (llama.cpp, API OpenAI).

Uso: python3 -I bench.py <saida_dir> [off|on|both]
"""
import json, os, sys, time, urllib.request

URL = "http://127.0.0.1:9931/v1/chat/completions"
MODEL = "qwen3.8-27b"
OUT = sys.argv[1]
MODES = {"both": ["off", "on"]}.get(sys.argv[2] if len(sys.argv) > 2 else "both",
                                     [sys.argv[2] if len(sys.argv) > 2 else "off"])

MERMAID_SYS = (
    "Você converte pedidos em diagramas Mermaid. Responda SOMENTE com o código Mermaid, "
    "sem cercas ``` e sem explicações. Use flowchart TD para processos e sequenceDiagram "
    "para interações entre participantes. Rótulos curtos, no idioma do pedido. "
    "Coloque rótulos com acentos ou parênteses entre aspas duplas."
)

WF_SYS = (
    "Você descreve a ESTRUTURA de uma tela de interface (wireframe) como uma árvore de blocos. "
    "Não informe posições nem tamanhos. Use só os tipos permitidos. Rótulos curtos no idioma do pedido. "
    "Para listas repetidas (ex.: cards de produtos), use um grid com 'columns' e repita os filhos (no máximo 8)."
)

KINDS = ["page", "header", "nav", "hero", "section", "grid", "card", "image", "text",
         "heading", "button", "input", "form", "list", "sidebar", "footer", "row", "column"]

def node_schema(depth):
    props = {
        "kind": {"type": "string", "enum": KINDS},
        "label": {"type": "string"},
        "columns": {"type": "integer", "minimum": 1, "maximum": 6},
    }
    if depth > 0:
        props["children"] = {"type": "array", "items": node_schema(depth - 1), "maxItems": 12}
    return {"type": "object", "properties": props, "required": ["kind"], "additionalProperties": False}

WF_SCHEMA = {"name": "wireframe", "strict": True, "schema": {
    "type": "object",
    "properties": {"title": {"type": "string"}, "root": node_schema(5)},
    "required": ["title", "root"], "additionalProperties": False}}

CASES = [
    ("fluxo_login", "mermaid", "Fluxograma do processo de login: o usuário digita e-mail e senha, o sistema valida; se for inválido mostra erro e volta ao formulário; se for válido verifica a autenticação em dois fatores e então abre o painel."),
    ("fluxo_compra", "mermaid", "Fluxograma de uma compra em loja online: carrinho, checkout, pagamento aprovado ou recusado (se recusado, tentar outro cartão), separação no estoque, envio e entrega."),
    ("seq_pedido", "mermaid", "Diagrama de sequência de um pedido de compra entre Cliente, API, Banco de Dados e Serviço de Pagamento."),
    ("wf_carros", "wireframe", "Página inicial de um site de venda de carros."),
    ("wf_login", "wireframe", "Tela de login de um aplicativo de banco."),
]

def run(case, mode):
    name, kind, prompt = case
    body = {
        "model": MODEL, "stream": True, "max_tokens": 8192 if mode == "on" else 3000,
        "messages": [{"role": "system", "content": MERMAID_SYS if kind == "mermaid" else WF_SYS},
                     {"role": "user", "content": prompt}],
        "chat_template_kwargs": {"enable_thinking": mode == "on"},
    }
    if kind == "wireframe":
        body["response_format"] = {"type": "json_schema", "json_schema": WF_SCHEMA}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time(); t_first_any = t_first_content = None
    content, reasoning, timings, err = "", "", None, None
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                ch = json.loads(data)
                if ch.get("timings"):
                    timings = ch["timings"]
                for c in ch.get("choices", []):
                    d = c.get("delta", {})
                    if d.get("reasoning_content"):
                        t_first_any = t_first_any or time.time()
                        reasoning += d["reasoning_content"]
                    if d.get("content"):
                        t_first_any = t_first_any or time.time()
                        t_first_content = t_first_content or time.time()
                        content += d["content"]
    except Exception as e:  # noqa
        err = repr(e)
    total = time.time() - t0
    valid, note = False, ""
    if kind == "wireframe":
        try:
            j = json.loads(content); valid = "root" in j
            def count(n): return 1 + sum(count(c) for c in n.get("children", []))
            note = f"{count(j['root'])} blocos"
        except Exception as e:  # noqa
            note = f"JSON inválido: {e!r}"[:120]
    else:
        s = content.strip()
        valid = s.split("\n", 1)[0].strip().split(" ")[0] in ("flowchart", "graph", "sequenceDiagram") and "```" not in s
        note = f"{len(s.splitlines())} linhas"
    res = {
        "case": name, "mode": mode, "total_s": round(total, 1),
        "ttft_s": round((t_first_any or t0) - t0, 2),
        "first_content_s": round((t_first_content or t0) - t0, 1),
        "reasoning_chars": len(reasoning), "content_chars": len(content),
        "gen_tok": timings and timings.get("predicted_n"), "tok_s": timings and round(timings.get("predicted_per_second", 0), 1),
        "prompt_tok": timings and timings.get("prompt_n"),
        "valid_basic": valid, "note": note, "error": err,
    }
    ext = "json" if kind == "wireframe" else "mmd"
    with open(os.path.join(OUT, f"{name}.{mode}.{ext}"), "w") as f:
        f.write(content)
    print(json.dumps(res, ensure_ascii=False), flush=True)
    return res

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    results = [run(c, m) for m in MODES for c in CASES]
    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
