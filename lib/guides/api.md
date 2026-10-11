# APIs e integrações
- Tokens e senhas sempre por referência: {{NOME}} nos headers/url/corpo. Se faltar, peça ao usuário para definir a variável de ambiente ou "secrets" no ~/.rfcode/config.json; nunca peça o token na conversa.
- Comece com GET de leitura para entender o formato; leia a documentação da API (web_fetch) quando não souber os endpoints.
- Paginação: siga page/cursor/link até o fim ou até o necessário; respeite retry-after e limites de taxa.
- POST, PUT, PATCH e DELETE mudam dados reais: confirme com o usuário o que será enviado, prefira ambiente de teste e evite repetir chamadas que criam registros.
- Grande volume: grave a resposta (save) e analise com data_query em vez de ler tudo na conversa.
