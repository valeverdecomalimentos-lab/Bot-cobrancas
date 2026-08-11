# Vale Verde Dashboard

O dashboard e executado pelo Electron e usa uma ponte IPC segura para chamar
os modulos locais do bot. Nao o abra por servidor HTTP ou diretamente pelo
navegador, pois importacao, WhatsApp, relatorios e Gemini dependem do processo
principal do Electron.

## Abrir

No Windows, execute `start-dashboard.bat`. Em desenvolvimento, use:

```bash
npm run electron
```

## Dados locais

Na versao compilada, clientes, configuracoes, templates, relatorios e a sessao
do WhatsApp ficam no diretorio de dados do usuario do sistema. Esses dados nao
sao gravados dentro do executavel e nao sao incluidos na build.

## Recursos

- Importacao de XLSX, CSV e PDF com texto selecionavel.
- Upsert por CPF, telefone ou nome normalizado, atualizando o saldo atual.
- Templates reais em arquivos TXT, com criacao, importacao, edicao e selecao.
- Envio de teste e campanhas reais via WhatsApp.
- Relatorios XLSX, CSV e TXT persistidos localmente.
- Relatorio executivo e chat Gemini usando `GEMINI_API_KEY` apenas no processo
  principal.

PDFs escaneados sem camada de texto devem ser exportados como XLSX ou CSV antes
da importacao.
