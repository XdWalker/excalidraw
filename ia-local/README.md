# IA local no Excalidraw — registro das fases

Fork pessoal, branch `ia-local`. Base: `excalidraw/excalidraw` commit `82d5847e5` (12/11/2026). Nada daqui é enviado ao repositório oficial.

## Fase 0 — Preparação e medição (12/11/2026)

### Ambiente medido

- PC: Ryzen 7 7700X, 32 GB DDR5, RTX 3090 24 GB.
- LLM: `llama-server` (llama.cpp b12018) em `http://127.0.0.1:9931/v1`, com `Qwen3.8-27B-UD-Q4_K_S`, 128k de contexto, 2 slots e decodificação especulativa MTP. Ocupa ~22 GB da GPU.
- App: `corepack yarn install --frozen-lockfile` e `vite` em `http://127.0.0.1:3001`.

### Como foi medido

Script: [`bench/bench.py`](bench/bench.py). Cada caso foi rodado uma vez, por streaming na API OpenAI do llama-server.

- Os fluxogramas usam um prompt de sistema que pede só Mermaid.
- Os wireframes usam `response_format: json_schema`, com uma árvore de blocos de tipos fixos e sem posições.
- O raciocínio foi alternado com `chat_template_kwargs.enable_thinking`.

As saídas brutas estão em `bench/saidas-*`.

### Resultados

| Caso | Sem raciocínio: total | Com raciocínio: total (1º texto útil) | Tokens gerados (sem / com) | Válido? |
| --- | --- | --- | --- | --- |
| Fluxograma de login | **1,5 s** | 6,3 s (5,5 s) | 86 / 464 | sim / sim |
| Fluxograma de compra | **1,5 s** | 7,0 s (6,2 s) | 93 / 500 | sim / sim |
| Sequência de pedido | **2,1 s** | 6,8 s (5,5 s) | 142 / 492 | sim / sim |
| Wireframe: site de carros | **13,4 s** (53 blocos) | 60,8 s (43,6 s) (60 blocos) | 1182 / 4845 | sim / sim |
| Wireframe: login de banco | **3,2 s** (10 blocos) | 21,4 s (19,0 s) (9 blocos) | 247 / 1470 | sim / sim |

- Velocidade de geração: ~83–92 tokens/s sem raciocínio e ~70–80 tokens/s com raciocínio. O primeiro token chega em ~0,4–0,55 s.
- **"Válido"** quer dizer:
  - Mermaid: os 3 diagramas sem raciocínio foram convertidos sem erro pelo `parseMermaidToExcalidraw` do próprio app, no navegador.
  - Wireframe: JSON aceito e com `root`.
- O esquema JSON funciona com o raciocínio ligado (a gramática só começa depois do raciocínio).

### Conclusões para as próximas fases

1. **Raciocínio desligado por padrão.** A qualidade foi equivalente nestes casos e a resposta saiu 4 a 5 vezes mais rápida. Pode virar uma opção "pensar mais" se algum caso precisar.
2. **O plano B da 2b já é o plano A.** O modelo descreve só a estrutura, com um conjunto fixo de blocos forçado pelo esquema; o nosso código calcula as posições.
3. **Problemas a corrigir no prompt e no esquema** (Fase 1 e Fase 3):
   - No diagrama de sequência, o modelo pôs aspas no apelido do participante (`participant X as "Banco de Dados"`), e as aspas aparecem no desenho. Isso foi causado pelo nosso prompt; ajustar a instrução.
   - Em um wireframe, a raiz veio como `nav` em vez de `page`. O esquema deve fixar a raiz como `page`.
   - O tipo `heading` não foi usado: o modelo usou `text` para títulos. Avaliar se vale manter os dois.
4. Os tempos são do PC forte. A Fase 7 mede máquinas modestas.

### Antes da mudança

![Texto para diagrama sem o servidor do Excalidraw](prints/fase0-antes-texto-para-diagrama.jpg)

Em modo de desenvolvimento, o "Texto para diagrama" chama `http://localhost:3016`, que não existe, e mostra "Error: Failed to fetch".

## Fase 1 — IA local no "Texto para diagrama" (12/11/2026)

### O que mudou

- **Novo cliente** [`excalidraw-app/ai/localLLM.ts`](../excalidraw-app/ai/localLLM.ts):
  - Fala com qualquer servidor compatível com a API de chat da OpenAI (llama.cpp, Ollama, LM Studio), direto do navegador, sem backend nem proxy.
  - Prompt de sistema próprio (só Mermaid, rótulos no idioma do pedido) e raciocínio desligado.
  - Converte o streaming `choices[0].delta.content` para o formato que o diálogo espera.
  - Limpa cercas ` ``` ` e blocos `<think>` ainda durante o streaming.
  - Erros claros: servidor fora do ar, erro HTTP, resposta vazia, cancelamento.
- **[`excalidraw-app/components/AI.tsx`](../excalidraw-app/components/AI.tsx)**: o diálogo passa a usar o cliente local no lugar do backend do excalidraw.com. O "Wireframe para código" continua como estava.
- **Selo "IA local · modelo @ host"** no cabeçalho do chat ([`LocalAIStatus.tsx`](../excalidraw-app/components/LocalAIStatus.tsx)):
  - Bolinha verde ou vermelha conforme a conexão.
  - Painel para trocar o endereço e o modelo, com "Testar conexão" e "Restaurar padrão". A escolha fica salva no `localStorage`.
- **Pacote do editor**:
  - Nova prop opcional `renderChatHeader` no `TTDDialog`, para o app mostrar o selo.
  - **Correção de um defeito do próprio Excalidraw** em [`useMermaidRenderer.ts`](../packages/excalidraw/components/TTDDialog/hooks/useMermaidRenderer.ts). Se a resposta terminava enquanto a pré-visualização ainda desenhava um trecho parcial, a versão final era descartada: a pré-visualização e o "Inserir" ficavam só com os primeiros nós. Com o servidor deles, lento, isso quase nunca acontece; com o Qwen local (~1,5 s por fluxograma), acontecia sempre. Agora o último pedido pendente é desenhado quando o anterior termina.
- **Configuração**:
  - `VITE_APP_LOCAL_LLM_URL` e `VITE_APP_LOCAL_LLM_MODEL` em `.env.development` e `.env.production`. O padrão é o Ollama (`http://127.0.0.1:11434/v1`).
  - Na máquina de desenvolvimento, `.env.development.local` (fora do git) aponta para o llama.cpp em `:9931`.
- **Textos** em inglês e português (`localAI.*` nos arquivos de idioma).

### Verificação

- **Testes automáticos:**
  - 16 testes novos em `excalidraw-app/ai/localLLM.test.ts` cobrem streaming, limpeza, configuração, modelo automático, servidor fora do ar, erro HTTP, 429, resposta vazia e cancelamento.
  - Os testes existentes do diálogo, do Mermaid e do app continuam passando (154 no total).
  - Typecheck e ESLint sem erros.
- **No navegador** (painel do Claude Code, Chromium):
  - Fluxograma de compra gerado e desenhado completo (8 etapas, decisão e laço).
  - Ajuste no mesmo chat ("adicione nota fiscal antes do envio") funcionou.
  - Endereço errado: selo vermelho e mensagem clara no chat.
  - Diagramas de sequência e de estados gerados sem as aspas que apareciam na fase 0.
  - Nas requisições observadas, só houve chamadas para `127.0.0.1`.
- **Validação humana no Firefox (12/11/2026, 23:42): aprovada.**
  - Três fluxogramas gerados e inseridos no quadro.
  - O da esquerda ("comprar GTA 6": 4 decisões, 7 desfechos que convergem) foi feito **com a internet desligada**.
  - Os outros dois foram feitos com a internet ligada.

![Validação no Firefox: o fluxograma da esquerda foi gerado offline](prints/fase1-firefox-validacao.webp)

### Observação para depois

Pedidos curtos tendem a virar fluxogramas lineares, e às vezes o processo é linear mesmo. Quando o pedido descreve condições e caminhos, o modelo gera ramificações (caso do GTA 6). Isso pode ser refinado no prompt ou em perfis de geração mais adiante.

![Depois: fluxograma gerado pela IA local](prints/fase1-depois-fluxograma.jpg)

![Configuração da IA local](prints/fase1-configuracao.jpg)
