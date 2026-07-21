# Changelog

Todas as mudanças relevantes do Expert Brain são registradas aqui. Formato inspirado em [Keep a Changelog](https://keepachangelog.com/), adaptado pro ritmo de release deste projeto. Os números de versão são marcos editoriais de release (como tag git, existem `v1.4.0` e `v3.0.0`; a "2.0.0" marca o lançamento do Console v2/v3 em produção).

## [Unreleased]

- **Fim do `overdue-nudge` + rate-limit no aviso de tasks da abertura** (`scripts/claude-hooks/`): o hook `expert-brain-overdue-nudge.cjs` (que cobrava task vencida DENTRO da sessão a cada 2h depois de 5h de sessão aberta) foi removido do pipeline — eram avisos de task demais. Agora o único aviso de tarefas é o da abertura de sessão, e ele ganhou rate-limit: aparece no máximo 1x por período do dia (manhã/tarde/noite, no fuso local da máquina) e nunca em retomada de sessão (`source=resume`), então abrir várias sessões no mesmo dia não vira cobrança o tempo todo. Pipeline caiu de 7 para 6 hooks; instalações existentes têm o `.cjs` órfão apagado e a entrada purgada do `settings.json` ao re-rodar `scripts/install-claude-hooks.mjs`.
- **Protocolo de granularidade nos hooks embarcados** (`scripts/claude-hooks/`): o mandato "tudo que o usuário pedir vira task" deu lugar à regra de granularidade — pedido pontual vira task direta e derivados viram subtarefas dela (`update_subtask`); software/iniciativa grande vira projeto com 1 card por módulo, nunca 1 card por ideia; na dúvida entre card e subtask, subtask. Textos atualizados em session-start, capture-nudge, postcompact e stop-sweep; alinha os hooks à filosofia já documentada no registry ("trabalho multi-parte = UM card com subtarefas, nunca N cards irmãos"). Instalações existentes recebem os textos novos ao re-rodar `scripts/install-claude-hooks.mjs`.

## [3.0.0] — 2026-07-07

Esteira de hardening e polish rodada em sequência contínua no dia seguinte ao lançamento do Console v2/v3: conserto do grafo 2D, share público de notas, edição inline e uma rodada grande de segurança e confiabilidade — cobrindo também o worker irmão de contatos (**expert-contacts**, que gerencia o vault de pessoas e conversa com o Brain via service binding).

- **Grafo 2D consertado**: notas órfãs agora gravitam pro cluster do próprio domínio em vez de boiarem soltas na tela; nós isolados somem de verdade da visualização; enquadramento inicial ajustado para caber o vault inteiro sem precisar dar zoom manual.
- **Share público de notas**: qualquer nota de conhecimento não-privada agora pode ser compartilhada por link público (`/s/<token>`), no mesmo mecanismo que já existia pra tarefas — com rate-limit e proxy de mídia protegido.
- **Edição inline**: notas e tarefas agora podem ser editadas direto no lugar, sem abrir formulário separado, com proteção contra edições concorrentes.
- **Hardening de login e SSO**: rate-limit no login replicado no console de contatos, handoff de sessão único (nonce single-use) entre os dois workers, e revogação de todas as sessões ativas ao trocar de senha ou fazer logout.
- **Privacidade reforçada**: notas e tarefas privadas agora ficam de fato invisíveis pra qualquer credencial sem o escopo adequado, em todos os caminhos de leitura (busca, recall, listagem, exportação); mesma lógica chegou pros contatos.
- **Mensagens de erro do MCP mais honestas**: quando uma operação falha (Workers AI fora do ar, contato inexistente, limite de mídia excedido), a mensagem de retorno agora diz o que realmente aconteceu em vez de um erro genérico.
- **Dependências atualizadas**: eliminados todos os alertas de segurança conhecidos nas bibliotecas usadas pelo projeto.
- **Categorização de contatos em massa**: scripts oficiais pra aplicar categorias por curadoria (seeds) e por cruzamento com as categorias de chat do WhatsApp, sempre com simulação (dry-run) antes de escrever e trilha de auditoria de quem categorizou o quê.
- **Integração com o vault de contatos**: avatar, categorias e observações de contato agora fluem corretamente entre os dois sistemas, incluindo correções de rotas que devolviam erro silencioso.

## [2.0.0] — 2026-07-06

Lançamento do **Console v2/v3**: o painel web (`/app`) deixa de ser só visualização de grafo e vira uma central de trabalho completa, com tarefas, contatos, captura rápida e memória, tudo no mesmo lugar.

- **Kanban de tarefas**: board com colunas customizáveis (criar, renomear, recolorir), cards no estilo ClickUp (tags, detalhe em duas colunas, criação inline) e comentários por tarefa — inclusive de convidados pelo link público de compartilhamento.
- **Projetos**: tarefas podem ser agrupadas em projetos/pastas, com filtro no board.
- **Contatos com dossiê completo**: página própria por contato, com vínculos de 1º e 2º grau, timeline de interações e observações semânticas pesquisáveis.
- **Credenciais com escopo**: tokens de acesso (PATs) agora podem ser limitados a permissões específicas (leitura, escrita, acesso a conteúdo privado), com revogação e histórico de uso.
- **Inbox de captura**: caixa de entrada pra jogar qualquer ideia rápida sem decidir na hora se vira nota, tarefa ou é descartada.
- **Menções**: citar um contato numa nota ou tarefa agora cria um vínculo automático, visível na página do contato — o "tecido conectivo" que liga memória, tarefas e pessoas.
- **Resurfacing / digest**: o sistema volta periodicamente com perguntas antigas em aberto, notas centrais esquecidas e itens parados na inbox, pra nada morrer de vista.
- **Home e journal**: tela inicial (`/app`) com o que importa do dia, e um diário cronológico de tudo que foi criado ou atualizado.
- **Busca unificada (Ctrl+K)**: uma paleta só pra achar nota, tarefa ou contato e disparar ações rápidas (criar tarefa, capturar, registrar interação).
- **PWA instalável**: o console pode ser instalado como app, recebe conteúdo compartilhado de outros apps do celular e tem atalhos rápidos.
- **Backup semanal automático**: os dois workers tiram snapshot completo (D1 → R2) toda semana, sem ação manual, com retenção das últimas versões.
- **Instruções do dono no handshake**: qualquer agente que conectar no MCP agora recebe automaticamente as instruções gerais configuradas pelo usuário.

## [1.4.0] e série 1.x — 2026-07-04

Nascimento do projeto: servidor MCP de conhecimento pessoal rodando 100% em Cloudflare, mais o pacote de instalação pra outros usuários.

- **Servidor MCP** (`/mcp`) com autenticação por OAuth 2.1 ou token pessoal (`eb_pat_*`).
- **Recall semântico** sobre embeddings multilíngues (`bge-m3` via Workers AI), com balanceamento entre domínios de conhecimento.
- **Notas atômicas com tipos canônicos** (conceito, decisão, insight, fato, padrão, princípio, pergunta).
- **Edges com justificativa obrigatória**: vínculo entre notas exige explicar o mecanismo compartilhado, não só marcar "relacionado".
- **Tarefas com kanban básico** direto pelo MCP.
- **Console web inicial** (`/app`) com visualização de grafo interativo em 2D e 3D.
- **Template de instalação** (`npm create @expertintegrado/expert-brain@latest`) pra qualquer pessoa subir a própria instância na conta Cloudflare dela.
