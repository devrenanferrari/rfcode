# Contribuindo com o rfcode

## Ambiente

Requisitos: Node.js 22 ou superior, git e VS Code. O projeto não tem dependências de runtime.

```bash
git clone https://github.com/devrenanferrari/rfcode
cd rfcode
npm test                      # executa os testes (node:test)
npx @vscode/vsce package      # gera o .vsix
code --install-extension rfcode-<versão>.vsix --force
```

Para usar a versão de desenvolvimento no terminal: `npm link` e depois `rfcode`.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `lib/` | Núcleo: agente, ferramentas, provedores, navegador, documentos, vídeo, controle remoto |
| `extension/` | Extensão do VS Code |
| `media/` | Painel de chat (HTML, CSS e JS da webview) |
| `bin/` | Versão de terminal |
| `test/` | Testes |
| `docs/` | Documentação de desenvolvimento e backlog (`docs/SDD.md`) |

Detalhes de arquitetura e do processo de release em [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Regras

- Nada de dependências de runtime. Código novo usa apenas Node.js e APIs do sistema.
- Toda funcionalidade nova em `lib/` vem com teste em `test/`. Os testes não acessam a rede: simule o `fetch` quando necessário (veja `test/resume.test.js`).
- Ações que alteram arquivos ou o sistema passam pelo fluxo de aprovação (`NEEDS_APPROVAL` em `lib/agent.js`).
- `lib/pc.ps1` deve conter apenas caracteres ASCII.
- Textos exibidos ao usuário ficam em português do Brasil, em tom direto.
- Antes de abrir um pull request: `npm test` precisa passar.

## Novo provedor de modelos

Provedores compatíveis com a API de chat da OpenAI são uma entrada em `PROVIDERS`, em `lib/providers.js`: nome, endereço base, variável de ambiente da chave e modelos sugeridos. Diferenças de parâmetros (como `max_completion_tokens`) ficam em `requestBody`.

## Nova ferramenta do agente

1. Defina o esquema em `TOOL_DEFS` (`lib/agent.js`) ou em um módulo próprio exportando a definição.
2. Implemente o método no `Agent` (ou o despacho correspondente em `send`).
3. Adicione o rótulo em `describeCall`.
4. Se a ferramenta altera algo, inclua em `NEEDS_APPROVAL`.
5. Escreva o teste.

## Releases

1. Atualize `version` no `package.json` e adicione a seção no `CHANGELOG.md`.
2. Faça o commit e crie a tag: `git tag vX.Y.Z && git push --tags`.
3. O GitHub Actions executa os testes, gera o `.vsix` e cria a release.

## Problemas

Ao relatar um bug, inclua a saída de `/doctor` e, se houver, as últimas linhas de `~/.rfcode/logs/rfcode.log` (as chaves de API são omitidas automaticamente).
