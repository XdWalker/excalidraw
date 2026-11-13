"""Compara prompts de sistema para o "Texto para diagrama" (A/B).

Uso: python3 -I prompt_ab.py <arquivo_prompt_A> <arquivo_prompt_B> <saida.json> [repeticoes]

Para cada pedido curto, gera N vezes com cada prompt e mede: tempo, número de
nós, de decisões, de arestas, de laços (aresta para nó já visto) e se começa
com um tipo de diagrama válido. A validação real (parse do Excalidraw) é feita
depois, no navegador, com o JSON de saída.
"""
import json, re, sys, time, urllib.request

URL = "http://127.0.0.1:9931/v1/chat/completions"
MODEL = "qwen3.8-27b"

PEDIDOS = [
    "Fluxograma de entrega de um pedido de loja online.",
    "Processo de contratação de um funcionário.",
    "Fluxo de login de um aplicativo.",
    "Como fazer café na cafeteira.",
    "Atendimento de suporte técnico de uma empresa de internet.",
    "Fluxograma de empréstimo de livro em uma biblioteca.",
]

def gen(system, user):
    body = {"model": MODEL, "temperature": 0.3, "max_tokens": 3000,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    t0 = time.time()
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        URL, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=300))
    return r["choices"][0]["message"]["content"].strip(), time.time() - t0

NODE = re.compile(r"\b([A-Za-z_][\w]*)\s*(\[\[|\[\(|\(\(|\[|\(|\{\{|\{|>)")
EDGE = re.compile(r"\b([A-Za-z_][\w]*)\b[^\n]*?(-->|-\.->|==>|---)[^\n]*?\b([A-Za-z_][\w]*)\b")

def stats(code):
    first = code.split("\n", 1)[0].strip().split(" ")[0]
    lines = code.splitlines()[1:]
    nodes, decisions, edges, order, back = set(), set(), 0, {}, 0
    for line in lines:
        s = line.strip()
        if not s or s.startswith(("%%", "subgraph", "end", "classDef", "class ", "style")):
            continue
        for m in NODE.finditer(s):
            nid = m.group(1)
            nodes.add(nid)
            order.setdefault(nid, len(order))
            if m.group(2) in ("{", "{{"):
                decisions.add(nid)
        # arestas: conta setas na linha
        n_arrows = len(re.findall(r"-->|-\.->|==>", s))
        edges += n_arrows
        m = EDGE.search(s)
        if m:
            a, b = m.group(1), m.group(3)
            order.setdefault(a, len(order)); order.setdefault(b, len(order))
            if order[b] < order[a]:
                back += 1
    return {"type": first, "nodes": len(nodes), "decisions": len(decisions), "edges": edges,
            "back_edges": back, "subgraphs": sum(1 for l in lines if l.strip().startswith("subgraph"))}

if __name__ == "__main__":
    prompts = {"A": open(sys.argv[1]).read(), "B": open(sys.argv[2]).read()}
    reps = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    out = []
    for pedido in PEDIDOS:
        for label, system in prompts.items():
            for i in range(reps):
                code, dt = gen(system, pedido)
                st = stats(code)
                row = {"pedido": pedido, "prompt": label, "rep": i, "secs": round(dt, 1), **st, "code": code}
                out.append(row)
                print(json.dumps({k: v for k, v in row.items() if k != "code"}, ensure_ascii=False), flush=True)
    json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
