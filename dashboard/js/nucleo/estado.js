// Fonte única de verdade do protótipo. Em produção, cada bloco abaixo é
// substituído pelas respostas reais dos endpoints REST/WebSocket do backend
// (ver mapeamento em js/nucleo/pontos-integracao.js).

const STORAGE_KEY = 'valeverde-dashboard-state-v1';

function criarEstadoInicial() {
  return {
    conexaoWhatsapp: { status: 'desconectado', numero: null }, // desconectado | aguardando_qr | conectado
    usuarioAtual: { nome: 'Usuário da empresa', papel: 'admin' },
    clientes: [],
    config: {
      chavePix: '',
      intervaloMin: 5,
      intervaloMax: 11,
      templates: [
        { id: 1, nome: 'Cobrança padrão', texto: 'Olá {{nome}}, tudo bem? Identificamos um saldo em aberto de {{valor}}. Podemos combinar o pagamento?' },
      ],
      usuarios: [],
    },
    historico: [],
    enviosSemana: [],
    campanhaEmAndamento: null,
    novaCampanhaTipoInicial: null,
  };
}

function carregarEstadoSalvo() {
  if (typeof window === 'undefined' || !window.localStorage) return criarEstadoInicial();
  try {
    const salvo = window.localStorage.getItem(STORAGE_KEY);
    if (!salvo) return criarEstadoInicial();
    const dados = JSON.parse(salvo);
    const base = criarEstadoInicial();
    return {
      ...base,
      ...dados,
      conexaoWhatsapp: { ...base.conexaoWhatsapp, ...(dados?.conexaoWhatsapp ?? {}) },
      usuarioAtual: { ...base.usuarioAtual, ...(dados?.usuarioAtual ?? {}) },
      config: {
        ...base.config,
        ...(dados?.config ?? {}),
        templates: Array.isArray(dados?.config?.templates) && dados.config.templates.length
          ? dados.config.templates
          : base.config.templates,
        usuarios: Array.isArray(dados?.config?.usuarios) ? dados.config.usuarios : [],
      },
      clientes: Array.isArray(dados?.clientes) ? dados.clientes : [],
      historico: Array.isArray(dados?.historico) ? dados.historico : [],
      enviosSemana: Array.isArray(dados?.enviosSemana) ? dados.enviosSemana : [],
    };
  } catch (erro) {
    console.warn('Não foi possível carregar o estado salvo.', erro);
    return criarEstadoInicial();
  }
}

export const estado = carregarEstadoSalvo();

export function persistirEstado() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(estado));
}

export function limparEstadoPersistido() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function calcularEnviosSemana(historico = estado.historico) {
  const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const semana = dias.map((dia) => ({ dia, enviados: 0, erros: 0 }));
  if (!Array.isArray(historico) || !historico.length) return semana;

  historico.forEach((item) => {
    const data = new Date(item.data);
    if (Number.isNaN(data.getTime())) return;
    const idx = data.getDay() === 0 ? 6 : data.getDay() - 1;
    const entrada = semana[idx];
    if (!entrada) return;
    entrada.enviados += item.enviados || 0;
    entrada.erros += item.erros || 0;
  });

  return semana;
}

// ---- barramento de eventos mínimo (substitui listeners de WebSocket) ----
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

export const formatarMoeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatarTelefone = (t) => {
  const valor = String(t ?? '').replace(/\D/g, '');
  if (!valor) return '—';
  if (valor.length === 13 && valor.startsWith('55')) return `(${valor.slice(2, 4)}) ${valor.slice(4, 9)}-${valor.slice(9)}`;
  if (valor.length === 11) return `(${valor.slice(0, 2)}) ${valor.slice(2, 7)}-${valor.slice(7)}`;
  return valor;
};
export const formatarData = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
