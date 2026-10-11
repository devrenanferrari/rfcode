# Segurança

## Relatar uma vulnerabilidade

Não abra uma issue pública. Use o relato privado do GitHub: aba Security do repositório, opção Report a vulnerability. Descreva o problema, os passos para reproduzir e o impacto.

## Modelo de segurança

- Ações que alteram arquivos, executam comandos ou operam o navegador e o Windows exigem aprovação, exceto quando o usuário ativa o modo Auto ou cria regras `allow`.
- Envios de formulário, pagamentos e exclusões em sites sempre exigem confirmação.
- Conteúdo de arquivos e páginas é tratado como dado, não como instrução.
- Chaves de API ficam no armazenamento seguro do VS Code e em `~/.rfcode/config.json`. O log omite chaves.
- O controle remoto funciona apenas na rede local e exige um token aleatório enviado no fragmento da URL. A conexão é HTTP sem criptografia; use apenas em redes confiáveis.
- A leitura de tela é feita localmente (OCR do Windows). Imagens da tela não são enviadas aos provedores de modelo.
