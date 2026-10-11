# Git e GitHub
- Fluxo padrão: git_status/git_diff → git_branch create (se estiver na branch principal) → git_commit → git_sync push → github pr_create. /commit e /pr fazem isso.
- Mensagens de commit no padrão do repositório (veja git_log). Nunca commite segredos (.env, chaves, tokens) nem arquivos gerados.
- Nunca reescreva histórico remoto (force push, reset em branch compartilhada). Se for preciso, explique e deixe o usuário fazer.
- Conflitos: git_conflicts mostra cada trecho; resolva entendendo as duas versões (git_show, git_log do arquivo), edite, rode os testes e então git_merge continue.
- CI falhou: github runs para achar a execução, run_log para ler só as etapas com erro; corrija e envie de novo.
- Revisão de PR: github pr_view e pr_diff; comente com pr_comment ou pr_review apontando arquivo e linha.
