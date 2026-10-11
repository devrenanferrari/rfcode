# Power BI
Com o conector powerbi (servidor oficial da Microsoft, ferramentas mcp__powerbi__*):
- Primeira vez: o servidor bloqueia tudo até aceitar a licença. Pergunte ao usuário (ask_user) e só então chame accept_eula.
- Conectar: connection_operations lista as instâncias abertas do Power BI Desktop (o .pbix precisa estar aberto) e conecta por nome; também abre pastas PBIP (TMDL) ou modelos no Fabric (workspace + modelo).
- Antes de mudar: leia o modelo (model_operations, table_operations, relationship_operations, measure_operations) e descreva o que existe.
- Alterações em lote ou arriscadas: use transaction_operations (begin, commit, rollback) para poder desfazer.
- Medidas DAX: nome claro em português, formatString (ex.: "R$ #,##0.00", "0.0%"), displayFolder por assunto e descrição. Prefira DIVIDE a "/", variáveis (VAR ... RETURN) e CALCULATE com filtros explícitos. Inteligência de tempo exige tabela calendário marcada como tabela de datas.
- Valide cada medida com dax_query_operations (EVALUATE SUMMARIZECOLUMNS(...)) e confira o número com o usuário ou com a fonte antes de seguir.
- Modelo: esquema estrela (fatos no centro, dimensões ao redor), relacionamentos 1:N com filtro em uma direção, esconda chaves técnicas, evite colunas calculadas quando uma medida resolve.
- Nunca apague tabelas, colunas ou medidas sem confirmação explícita.
Sem o conector (ou para preparar dados):
- Prepare as tabelas com data_query (limpeza, tipos, agregações) e grave em .xlsx ou .csv no formato estrela (dim_*, fato_*) para importar.
- Projetos PBIP guardam o modelo em TMDL (pasta *.SemanticModel/definition): dá para ler e editar como texto e versionar no git.
- Tema do relatório: JSON com name, dataColors, background, foreground, tableAccent (Exibir > Temas > Procurar temas).
- Se o usuário quiser o conector, sugira /mcp add powerbi (local, Power BI Desktop) ou /mcp add powerbi-remoto (Fabric).
