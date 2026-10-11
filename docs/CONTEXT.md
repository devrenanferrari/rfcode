# Gestão de contexto

Modelos têm uma janela de contexto fixa (de 8 mil a 1 milhão de tokens, conforme o provedor). Uma tarefa longa, com dezenas de ações, ultrapassa essa janela facilmente. Este documento descreve como o rfcode mantém conversas longas funcionando sem perder o fio da tarefa. O código fica em `lib/context.js` e em `Agent.maybeCompact` / `Agent.compactNow` (`lib/agent.js`).

## Princípios

1. **Medir o que importa.** O total de tokens gastos na conversa não diz se a próxima chamada cabe. O rfcode usa o `prompt_tokens` real da última chamada, informado pela API, mais uma estimativa do que entrou depois (cerca de 3,6 caracteres por token). O painel e o terminal mostram essa ocupação ("contexto 32%").
2. **Compactar cedo e no meio da tarefa.** A verificação acontece antes de cada chamada ao modelo, e não apenas no início de cada pedido. Ao passar de 65% da janela (`COMPACT_AT`), a compactação é feita antes de continuar.
3. **Compactação incremental.** Só a parte antiga é resumida. O trecho mais recente, até cerca de 30% da janela (`KEEP_RECENT`), segue literal. O corte nunca separa uma chamada de ferramenta do seu resultado. Quando já existe um resumo anterior, ele entra no novo, em vez de ser descartado.
4. **Estado determinístico.** Algumas informações não dependem do modelo lembrar. O rfcode anexa ao resumo, a partir dos próprios dados:
   - o último pedido do usuário anterior ao corte, literal;
   - o plano atual, com o status de cada passo;
   - os arquivos criados ou alterados na conversa;
   - os comandos ainda rodando em segundo plano.
5. **Resumo estruturado.** O resumo segue seções fixas: pedidos e objetivo, decisões e preferências, o que já foi feito, informações importantes, estado atual e próximos passos.
6. **Recuperação de estouro.** Se mesmo assim a API recusar por excesso de contexto, o rfcode lê o limite real na mensagem de erro, passa a usá-lo, compacta mantendo só 15% da janela e repete a chamada uma vez.

## Outras medidas que reduzem o uso de contexto

- **Saídas antigas encurtadas.** Resultados antigos de ferramentas que geram muito texto (navegador, OCR, comandos, buscas) são encurtados nas chamadas seguintes. Só os 4 mais recentes vão inteiros (`compactHistory`).
- **Leitura sem repetição.** Ler de novo o mesmo trecho de um arquivo que não mudou devolve um aviso curto, e não o conteúdo de novo.
- **Subagentes.** Leituras grandes (vários PDFs, pastas inteiras, pesquisas com muitas fontes) vão para a ferramenta `task`. O subagente lê num contexto separado e devolve apenas o relatório.
- **Limites por ferramenta.** Cada saída de ferramenta é truncada em 20 mil caracteres. Páginas web são lidas em partes (`browser read` com `offset`).

## Janelas por provedor

Os valores padrão ficam em `WINDOWS` (`lib/context.js`). Para modelos com janela diferente, configure em `~/.rfcode/config.json`:

```json
{
  "contextWindow": 32768,
  "contextWindows": { "ollama:qwen3:8b": 32768 }
}
```

Servidores locais (Ollama, LM Studio) costumam carregar o modelo com uma janela pequena. O padrão conservador é 8 mil tokens.

## Ajuste fino

| Parâmetro | Onde | Efeito |
|---|---|---|
| `COMPACT_AT` | `lib/context.js` | Fração da janela que dispara a compactação (0,65) |
| `KEEP_RECENT` | `lib/context.js` | Fração da janela mantida literal (0,3) |
| `KEEP_RECENT` (saídas) | `lib/agent.js` | Quantas saídas recentes de ferramentas ficam inteiras (4) |
| `MAX_OUTPUT` | `lib/agent.js` | Limite de caracteres de cada saída de ferramenta (20 mil) |

Testes: `test/context.test.js`.
