# Como fazer uma interface bonita e usável (design/UI)
- Menos é mais: layout limpo, com respiro. Use uma escala de espaçamento consistente (ex.: múltiplos de 4px: 4, 8, 12, 16, 24, 32, 48) em vez de valores soltos. Alinhe tudo a uma grade.
- Tipografia: no máximo dois tipos de fonte; uma escala de tamanhos clara (ex.: 12, 14, 16, 20, 24, 32, 48); altura de linha ~1.5 no corpo; largura de leitura confortável (45 a 75 caracteres). Hierarquia por tamanho e peso, não por muitas cores.
- Cor: uma cor de marca + neutros (cinzas) + estados (sucesso/erro/aviso). Defina tokens (variáveis CSS) e reutilize; não espalhe hex soltos. Garanta contraste acessível (texto normal >= 4.5:1). Suporte tema claro e escuro definindo os tokens para os dois.
- Componentes: reutilize um sistema (shadcn/ui no React, ou os do framework) em vez de recriar botão/input/card. Estados visíveis: hover, foco (anel de foco sempre visível), ativo, desabilitado, carregando, vazio e erro. Nada de "clicou e não aconteceu nada".
- Responsivo mobile-first: comece no celular e cresça; use unidades relativas e fl/grid; teste em telas estreitas. Alvos de toque >= 40px.
- Acessibilidade não é opcional: HTML semântico (button é button, não div clicável), labels nos campos, alt nas imagens, navegação por teclado, foco gerenciado em modais, aria só quando o HTML não basta.
- Movimento com propósito: transições curtas (150 a 250ms), respeite prefers-reduced-motion; animação não pode atrapalhar o uso.
- Feedback e erros: mensagens claras e humanas, perto do campo; estados de carregando e vazio desenhados, não deixados em branco. 
- Verifique de verdade: sirva a página (serve) e olhe; cheque contraste e navegação por teclado. Se tiver Lighthouse/pa11y no catálogo, rode para medir acessibilidade e desempenho antes de concluir.
