# Vale Verde Dashboard

Aplicativo desktop em Electron para organizar clientes, importar listas e backups do Consumer, montar campanhas de cobranca ou promocao, enviar mensagens pelo WhatsApp e consultar contexto operacional com IA.

O projeto foi pensado para rodar localmente no Windows, mantendo dados sensiveis fora do Git: sessoes do WhatsApp, bancos, backups, relatorios, planilhas e PDFs importados ficam apenas na maquina do usuario.

## Principais recursos

- Dashboard desktop com abas de clientes, produtos, historico, envio, campanhas e configuracoes.
- Importacao centralizada em **Configuracoes > Fontes de dados**.
- Suporte a arquivos `.fb`, `.fbconsumer`, `.fbk`, `.gbk`, `.bak`, `.backup`, `.pdf`, `.csv`, `.xls` e `.xlsx`.
- Suporte a links do Google Drive para arquivo especifico ou pasta publica de backups.
- Sincronizacao de pasta do Drive priorizando o backup mais novo detectado.
- Perfis de clientes enriquecidos com compras, pagamentos, dividas, produtos e frequencia.
- Campanhas de cobranca e promocao com mensagem exatamente igual ao template digitado, apenas substituindo placeholders.
- Relatorios locais em formatos de leitura e auditoria.
- Integracao de IA com contexto controlado e credenciais guardadas localmente.

## Requisitos

- Windows 10 ou superior.
- Node.js 24 ou superior.
- `npm install` executado uma vez no repositorio.
- Firebird 4 instalado quando for importar/restaurar backups Consumer localmente.

## Como abrir

Para uso pelo atalho da area de trabalho, execute:

```powershell
.\start-dashboard.bat
```

Em desenvolvimento, use:

```powershell
npm run electron
```

O `start-dashboard.bat` chama o `start-dashboard.ps1`. Quando `node_modules` existe, ele abre os arquivos-fonte atuais pelo Electron local; o pacote em `dist/` fica apenas como alternativa.

## Como gerar instalador

```powershell
npm install
npm run dist
```

O instalador e gerado em `dist/`. Essa pasta e ignorada pelo Git e nao deve ser commitada.

## Importacao de dados

Toda importacao deve acontecer na aba **Configuracoes**:

- **Arquivo local:** selecione planilhas, PDFs ou backups do Consumer.
- **Link do Drive:** cole link de arquivo ou de pasta.
- **Pasta do Drive:** o sistema salva a pasta e resincroniza buscando o backup mais novo disponivel.

Arquivos de cliente, produto, PDF, planilha e backup contem dados reais e devem permanecer fora do repositorio.

## Mensagens

O texto enviado pelo WhatsApp vem somente do template ou da mensagem personalizada informada na campanha.

Placeholders suportados incluem:

```text
{{nome}}
{{valor}}
{{numero}}
{{telefone}}
{{pix}}
```

O sistema nao adiciona aviso automatico, rodape, cliente, numero ou valor fora do que estiver escrito no template.

## Testes

Testes unitarios:

```powershell
npm run test:unit
```

Testes de interface Electron:

```powershell
npm run test:e2e
```

Suite completa:

```powershell
npm test
```

Observacao atual: existe uma falha conhecida em `tests/whatsapp.test.js` relacionada ao tempo de exibicao do QR no terminal. Ela nao esta ligada aos fluxos de importacao, campanha ou template.

## Estrutura

```text
core/                 Logica do bot, importadores, IA, WhatsApp e persistencia
dashboard/            Interface Electron
templates/            Templates padrao versionados
tests/                Testes unitarios e E2E
build/                Icones usados pelo empacotador
electron-main.js      Processo principal do Electron
preload.js            Ponte segura entre interface e processo principal
config.js             Configuracoes padrao do projeto
```

## O que nao entra no Git

O `.gitignore` bloqueia dependencias, build, caches, sessoes do WhatsApp, bancos locais, relatorios, uploads, backups Firebird, planilhas, PDFs, credenciais e artefatos de teste.

Antes de commitar, confira:

```powershell
git status --short
git diff --check
```

Se aparecer algo como `.wwebjs_auth`, `.wwebjs_cache`, `dist`, `data`, `reports`, `uploads`, planilhas, PDFs ou backups, esse arquivo nao deve entrar no commit.



google driver: https://drive.google.com/drive/folders/1lTZQ8gq7l0c9QpzUqSg_EPUPjt9wqH4n