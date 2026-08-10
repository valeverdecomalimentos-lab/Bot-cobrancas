# Vale Verde Dashboard para Windows

## O que foi preparado
- App desktop com Electron
- Janela que abre o dashboard local
- Ícone próprio para Windows
- Configuração para gerar instalador .exe

## Como gerar o executável
1. Instale Node.js e Python 3.
2. Abra o terminal na pasta do projeto.
3. Execute:
   ```bash
   npm install
   npm run dist
   ```
4. O instalador será gerado em `dist/`.

## Como usar
- O app abre automaticamente o dashboard em `http://127.0.0.1:9000/dashboard/`.
- O instalador cria atalho na Área de Trabalho e no Menu Iniciar.

## Observação
Se o processo do Electron estiver travado, feche todas as janelas abertas e rode novamente `npm run dist`.
