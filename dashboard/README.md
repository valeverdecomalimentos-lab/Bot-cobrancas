# Vale Verde Dashboard

O dashboard e executado pelo Electron e usa uma ponte IPC segura para chamar
os modulos locais do bot. Nao o abra por servidor HTTP ou diretamente pelo
navegador, pois importacao, WhatsApp, relatorios e IA dependem do processo
principal do Electron.

## Abrir

No Windows, execute `start-dashboard.bat`. Em desenvolvimento, use:

```bash
npm run electron
```

Para validar a interface e os fluxos locais em um perfil isolado:

```bash
npm test
```

## Dados locais

Na versao compilada, clientes, configuracoes, templates, relatorios e a sessao
do WhatsApp ficam no diretorio de dados do usuario do sistema. Esses dados nao
sao gravados dentro do executavel e nao sao incluidos na build.

## Recursos

- Importacao de todas as abas de XLS/XLSX, alem de CSV e PDF com texto selecionavel.
- Upsert por CPF, telefone ou nome normalizado, atualizando o saldo atual.
- Templates reais em arquivos TXT, com criacao, importacao, edicao e selecao.
- Envio de teste e campanhas reais via WhatsApp.
- Relatorios XLSX, CSV e TXT persistidos localmente.
- PIX estruturado por favorecido, tipo e chave, aplicado ao teste e ao envio real.
- Relatorio executivo e chat com Gemini ou OpenAI, Markdown seguro, historico local, cache,
  continuacao automatica e contexto orientado a pergunta.
- Propostas operacionais da IA abrem o fluxo de revisao; a IA nao dispara,
  agenda ou altera dados sem uma acao humana.

## Configurar a IA

Abra **Configuracoes > Inteligencia Artificial**, escolha Google Gemini ou
OpenAI, selecione o modelo e cole a chave do provedor. O aplicativo valida a
chave antes de aplica-la e a mantem no cofre criptografado do sistema
operacional. Depois de salva, a chave nunca e devolvida ao dashboard; a tela
mostra somente os quatro ultimos caracteres.

Nao e necessario criar ou distribuir um arquivo `.env`. Cada instalacao guarda
as credenciais separadamente no diretorio de dados do usuario. Ao usar OpenAI,
as requisicoes sao enviadas com armazenamento de respostas desativado
(`store: false`). O contexto necessario e enviado somente ao provedor ativo;
contatos, documentos e colunas de segredos das planilhas sao omitidos antes da
montagem do prompt.

PDFs escaneados sem camada de texto devem ser exportados como XLSX ou CSV antes
da importacao.
