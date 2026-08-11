export const estado = {
  conexaoWhatsapp: { status: 'desconectado', numero: null, qrDataUrl: null },
  clientes: [],
  produtos: [],
  historico: [],
  importacoes: [],
  sincronizacao: null,
  config: { chavePix: '', intervaloMin: 5, intervaloMax: 11, templates: [] },
  gemini: { disponivel: false, modelo: null, relatorio: '', diagnostico: '', conversa: [] },
  campanhaEmAndamento: null,
  novaCampanhaTipoInicial: null,
};

export function aplicarBootstrap(dados = {}) {
  estado.clientes = Array.isArray(dados.clientes) ? dados.clientes : [];
  estado.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
  estado.historico = Array.isArray(dados.relatorios) ? dados.relatorios : [];
  estado.importacoes = Array.isArray(dados.importacoes) ? dados.importacoes : [];
  estado.sincronizacao = dados.sincronizacao || null;
  estado.config = {
    chavePix: '',
    intervaloMin: 5,
    intervaloMax: 11,
    ...(dados.configuracoes || {}),
    templates: Array.isArray(dados.templates) ? dados.templates : [],
  };
  estado.conexaoWhatsapp = { ...estado.conexaoWhatsapp, ...(dados.whatsapp || {}) };
  estado.gemini = { ...estado.gemini, ...(dados.gemini || {}) };
}

export function atualizarConexaoWhatsapp(dados = {}) {
  estado.conexaoWhatsapp = { ...estado.conexaoWhatsapp, ...dados };
}

export function calcularEnviosSemana(historico = estado.historico) {
  const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
  const semana = dias.map((dia) => ({ dia, enviados: 0, erros: 0 }));
  (Array.isArray(historico) ? historico : []).forEach((item) => {
    const data = new Date(item.data);
    if (Number.isNaN(data.getTime())) return;
    const indice = data.getDay() === 0 ? 6 : data.getDay() - 1;
    semana[indice].enviados += Number(item.enviados || 0);
    semana[indice].erros += Number(item.erros || 0);
  });
  return semana;
}

const ouvintes = new Map();
export const barramento = {
  on(evento, fn) {
    if (!ouvintes.has(evento)) ouvintes.set(evento, new Set());
    ouvintes.get(evento).add(fn);
    return () => ouvintes.get(evento)?.delete(fn);
  },
  emit(evento, payload) {
    ouvintes.get(evento)?.forEach((fn) => fn(payload));
  },
};

export const formatarMoeda = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatarTelefone = (telefone) => {
  const valor = String(telefone ?? '').replace(/\D/g, '');
  if (!valor) return '--';
  const nacional = valor.startsWith('55') && valor.length >= 12 ? valor.slice(2) : valor;
  if (nacional.length === 11) return `(${nacional.slice(0, 2)}) ${nacional.slice(2, 7)}-${nacional.slice(7)}`;
  if (nacional.length === 10) return `(${nacional.slice(0, 2)}) ${nacional.slice(2, 6)}-${nacional.slice(6)}`;
  return valor;
};
export const formatarData = (iso) => {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '--';
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
