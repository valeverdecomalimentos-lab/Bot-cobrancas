# Vale Verde — Painel de disparos WhatsApp (protótipo navegável)

Front-end estático (HTML + CSS + JS puro, sem framework/build) do painel
descrito no briefing. Dados mockados; pronto para plugar no backend
Node.js (`whatsapp-web.js` + Express/WebSocket) do repositório
`Bot-cobrancas`.

## Como abrir

Módulos ES exigem HTTP (não abrem via `file://`). Na pasta do projeto:

```bash
python3 -m http.server 8080
# ou: npx serve .
```

Acesse `http://localhost:8080`. Fluxo: **Login → Painel → Clientes /
Nova campanha → Envio em andamento → Histórico → Configurações**.

### Windows: abrir com um clique no desktop

Para facilitar o uso por todos os funcionários no Windows, use o atalho
`start-dashboard.bat` na raiz do repositório. Ele inicia o servidor local e
abre o painel automaticamente.

Passos:

1. Clique com o botão direito em `start-dashboard.bat`.
2. Escolha `Criar atalho`.
3. Arraste o atalho para a Área de Trabalho.
4. Dê um duplo clique no atalho para abrir o painel.

Se quiser, também pode renomear o atalho para algo como
`Vale Verde - Dashboard`.

Na tela de login, clique em **Gerar QR Code**: após ~3,5s a conexão
simula sucesso automaticamente (representa o evento `whatsapp:conectado`).

## Estrutura

```
index.html
css/tokens.css          → paleta, tipografia, componentes base
css/layout.css           → shell + estilos de cada tela
js/nucleo/estado.js       → dados mock + barramento de eventos (pub/sub)
js/nucleo/pontos-integracao.js → mapa único de endpoints REST/WS reais
js/nucleo/roteador.js     → roteador por hash
js/nucleo/ui.js           → modal, toast, helpers de DOM
js/nucleo/icones.js       → ícones SVG inline (sem dependência externa)
js/telas/*.js             → uma tela por módulo (login, dashboard, clientes,
                             wizard de campanha, envio, histórico, config)
js/app.js                 → bootstrap, shell (sidebar) e registro de rotas
integracao-ia/sugestao-mensagem.js → módulo opcional de IA (ver abaixo)
```

## Ligar ao backend real

Toda chamada de rede do protótipo passa, conceitualmente, pelo mapa em
`js/nucleo/pontos-integracao.js` — é o único lugar que precisa mudar:

| Ponto do backend (`core/*.js`) | Endpoint | Evento WS |
|---|---|---|
| `core/whatsapp.js` | `GET /api/whatsapp/status` | `whatsapp:qr`, `whatsapp:conectado` |
| `core/excel.js` | `POST /api/clientes/importar` | — |
| — | `GET /api/clientes` | — |
| `core/sender.js` | `POST /api/campanhas` | `envio:progresso`, `envio:log` |
| `core/report.js` | `GET /api/relatorios`, `GET /api/relatorios/:id` | — |

Para produção: troque `SIMULADO = true` por `false` nesse arquivo e
substitua as funções de mock em `estado.js`/telas por `fetch()` e um
cliente WebSocket real, escutando os mesmos nomes de evento já usados no
`barramento` (`whatsapp:conectado`, `envio:progresso`, `envio:log`).

## IA opcional (Gemini)

`integracao-ia/sugestao-mensagem.js` é um módulo desacoplado para o
**backend** (Node/Express), não para este front-end. Ele:

- lê a chave de `process.env.GEMINIKEY` (defina no `.env` do bot);
- gera uma sugestão de mensagem de cobrança ou promoção já com
  `{{nome}}`/`{{valor}}`;
- expõe o contrato esperado em `POST /api/ia/sugerir-mensagem`, já
  referenciado em `pontos-integracao.js` (`ENDPOINTS.sugerirMensagemIA`).

Nada é chamado automaticamente — é opt-in, com tratamento de erro e sem
travar o fluxo de envio caso a chave falhe ou a API esteja fora do ar.

## Notas de segurança

Este pacote **não inclui** dados reais de clientes, sessões autenticadas
do WhatsApp (`.wwebjs_auth`) nem relatórios de envio do repositório
original — apenas dados de exemplo gerados em memória, para que o
protótipo possa ser compartilhado sem expor informação sensível.
