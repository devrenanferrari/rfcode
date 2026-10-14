# Plasticidade do rfcode

O que o rfcode precisa para ter "energia" e "plasticidade neural": não é uma coleção de ferramentas,
e sim um sistema que se adapta com a experiência. Este documento é o mapa do que foi construído e de
como as peças formam esse sistema. A metáfora do cérebro é só um guia; a implementação é simples e testada.

## As faculdades (o que cada peça faz no "cérebro")

| Faculdade (cérebro) | No rfcode | Papel |
|---|---|---|
| Memória de trabalho | `note`, `update_plan`, compactação de contexto | Segura fatos e o plano durante a tarefa |
| Memória de longo prazo | `lib/brain.js` (`learn`/`recall`), injeção no system prompt | Guarda o que descobriu sobre o projeto entre conversas |
| Metacognição | `think`, `self_check` | Para e raciocina antes de agir; verifica o resultado |
| Cálculo exato | `compute` | Conta sem erro (o modelo sozinho erra aritmética) |
| Percepção/exploração | `deep_research`, `web_search`, `detect_stack` | Traz informação de fora e lê o terreno |
| Repertório motor que cresce | catálogo (`toolbox`) + `ensure_tool` | ~250 CLIs que ele descobre, instala sob demanda e usa |
| Mãos (atuadores) | `apply_patch`, `run_tests`, `replace_in_files`, `serve`, `archive`, edição/comando | Age no mundo (código, testes, arquivos) |
| Hábitos/procedimentos | skills (`SKILL.md`), comandos custom | Procedimentos ensinados, reutilizáveis |
| Plasticidade de desenvolvimento | `scripts/self-improve.js` | O sistema reescreve o próprio código em ciclos |
| **Reforço por resultado** | **`reflect`, `reinforce`, peso no cérebro** | **Fecha o ciclo: a experiência muda o que fica forte** |

## O ciclo que dá plasticidade de verdade

Plasticidade = o sistema muda a si mesmo conforme o que vive. O ciclo tem quatro tempos:

1. **Lembrar antes de agir.** No começo da tarefa, `recall` traz o que já se sabe do projeto; o `brief`
   do cérebro entra no prompt automaticamente. Começar do zero é a exceção, não a regra.
2. **Agir e verificar.** `think` para decisões difíceis, as mãos para executar, `self_check` e `run_tests`
   para conferir contra o pedido. Nada "concluído" sem checar.
3. **Consolidar.** No fim de uma tarefa com tentativa e erro, `reflect` grava de uma vez o que funcionou
   (`worked`) e o que evitar (`avoid`). É a "consolidação do sono": a experiência da tarefa vira memória.
4. **Reforçar.** `reinforce` e o peso de cada fato ajustam a força pelo resultado: o que ajudou de novo
   sobe e fica à vista; o que enganou desce e, se zerar, é esquecido. `recall` por si só já reforça o que é
   usado (uso-dependente). É o "ajuste sináptico".

Sem o passo 3 e 4, o agente só tinha memória passiva (guardava se lembrasse). Com eles, ele **melhora com a
experiência**: repete menos erros e chega mais rápido ao que funciona, projeto a projeto.

## O que ainda falta para ir além (próximos passos)

Isto é honesto sobre os limites atuais:

- **Captura automática.** Hoje a consolidação depende do agente chamar `reflect`/`learn` (incentivado pelo
  prompt). Um gancho no fim da tarefa que sugira isso de forma mais firme, ou capture sinais óbvios
  (teste vermelho -> verde, erro repetido -> correção) sem depender da lembrança do modelo, fecharia a última
  folga. Fica como gancho de loop, não de ferramenta, por ser mais invasivo.
- **Cérebro compartilhado por equipe.** Hoje `.rfcode/brain.json` é local. Sincronizar (opt-in) o que é do
  projeto, e não do usuário, deixaria a equipe aprender junto.
- **Esquecimento ativo.** Há decaimento por recência e poda por peso baixo e por teto de fatos; falta uma
  revisão periódica que funda lições parecidas e aposente as obsoletas.
- **Habilidade a partir de hábito.** Quando um mesmo procedimento se repete, promovê-lo automaticamente a uma
  skill (`SKILL.md`) seria a plasticidade virando estrutura.

## Princípio de projeto

A capacidade cresce sem inchar o contexto: ferramentas raras entram sob demanda (grupos por assunto), o
repertório de CLIs vive num catálogo pesquisável (não numa ferramenta por programa), e o que é durável vive no
cérebro, não no prompt. Energia aqui é isso: muito alcance disponível, pouco peso fixo, e um ciclo que aprende.
