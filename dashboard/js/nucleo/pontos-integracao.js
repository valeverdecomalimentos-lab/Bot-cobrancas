// Mapa único de integração com o backend Node.js (core/*.js do bot).
// Trocar `SIMULADO` por chamadas fetch()/WebSocket reais é a ÚNICA mudança
// necessária para sair do protótipo e ir para produção — nenhuma tela
// depende diretamente de rede, todas passam por este módulo.

export const ENDPOINTS = {
  statusWhatsapp: { metodo: 'GET', rota: '/api/whatsapp/status' },
  wsQr: 'whatsapp:qr',
  wsConectado: 'whatsapp:conectado',
  importarClientes: { metodo: 'POST', rota: '/api/clientes/importar' },
  listarClientes: { metodo: 'GET', rota: '/api/clientes' },
  criarCampanha: { metodo: 'POST', rota: '/api/campanhas' },
  wsProgresso: 'envio:progresso',
  wsLog: 'envio:log',
  listarRelatorios: { metodo: 'GET', rota: '/api/relatorios' },
  detalheRelatorio: { metodo: 'GET', rota: '/api/relatorios/:id' },
  // Opcional — geração assistida de mensagem via IA (Gemini). Ver README.
  sugerirMensagemIA: { metodo: 'POST', rota: '/api/ia/sugerir-mensagem' },
};

export const SIMULADO = true; // false quando plugado ao backend real
