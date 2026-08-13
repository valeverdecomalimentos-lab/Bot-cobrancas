export const TIPOS_CHAVE_PIX = Object.freeze({
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  telefone: 'Telefone',
  aleatoria: 'Chave aleatória',
});

const textoPix = (valor) => String(valor ?? '').trim().replace(/\s+/g, ' ');
const digitosPix = (valor) => String(valor ?? '').replace(/\D/g, '');

function cpfValido(valor) {
  const digitos = digitosPix(valor);
  if (digitos.length !== 11 || /^(\d)\1+$/.test(digitos)) return false;
  const calcular = (tamanho) => {
    let total = 0;
    for (let indice = 0; indice < tamanho; indice += 1) total += Number(digitos[indice]) * (tamanho + 1 - indice);
    const resto = (total * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calcular(9) === Number(digitos[9]) && calcular(10) === Number(digitos[10]);
}

function cnpjValido(valor) {
  const digitos = digitosPix(valor);
  if (digitos.length !== 14 || /^(\d)\1+$/.test(digitos)) return false;
  const calcular = (tamanho) => {
    const pesos = tamanho === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const total = pesos.reduce((soma, peso, indice) => soma + Number(digitos[indice]) * peso, 0);
    const resto = total % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return calcular(12) === Number(digitos[12]) && calcular(13) === Number(digitos[13]);
}

export function inferirTipoChavePix(chave) {
  const valor = textoPix(chave);
  if (!valor) return 'aleatoria';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(valor)) return 'email';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor)) return 'aleatoria';
  if (cpfValido(valor)) return 'cpf';
  if (cnpjValido(valor)) return 'cnpj';
  const digitos = digitosPix(valor);
  if (digitos.length >= 10 && digitos.length <= 13) return 'telefone';
  return 'aleatoria';
}

function normalizarTipoPix(tipo, chave) {
  const valor = textoPix(tipo).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const aliases = {
    cpf: 'cpf', cnpj: 'cnpj', email: 'email', 'e-mail': 'email',
    telefone: 'telefone', celular: 'telefone', phone: 'telefone',
    aleatoria: 'aleatoria', aleatorio: 'aleatoria', random: 'aleatoria', evp: 'aleatoria',
  };
  return aliases[valor] || inferirTipoChavePix(chave);
}

export function normalizarConfigPix(config = {}) {
  const origem = config && typeof config === 'object' ? config : {};
  const pix = origem.pix && typeof origem.pix === 'object' ? origem.pix : {};
  const nomeFavorecido = textoPix(
    pix.nomeFavorecido ?? pix.nome ?? pix.favorecido
    ?? origem.nomeFavorecido ?? origem.nomeFavorecidoPix ?? origem.pixNomeFavorecido ?? '',
  );
  const chave = textoPix(pix.chave ?? pix.key ?? origem.chave ?? origem.chavePix ?? origem.pixChave ?? '');
  const tipo = normalizarTipoPix(
    pix.tipo ?? pix.tipoChave ?? origem.tipo ?? origem.tipoChavePix ?? origem.pixTipo,
    chave,
  );
  return { nomeFavorecido, chave, tipo };
}

export function validarConfigPix(config = {}, { permitirVazio = false } = {}) {
  const pix = normalizarConfigPix(config);
  const erros = {};
  if (permitirVazio && !pix.nomeFavorecido && !pix.chave) return { valido: true, pix, erros, mensagem: '' };

  if (!pix.nomeFavorecido) erros.nomeFavorecido = 'Informe o nome do favorecido que aparece na conta PIX.';
  else if (pix.nomeFavorecido.length < 3) erros.nomeFavorecido = 'O nome do favorecido precisa ter pelo menos 3 caracteres.';
  else if (pix.nomeFavorecido.length > 120) erros.nomeFavorecido = 'O nome do favorecido deve ter no máximo 120 caracteres.';

  if (!pix.chave) erros.chave = 'Informe a chave PIX.';
  else if (pix.chave.length > 140) erros.chave = 'A chave PIX deve ter no máximo 140 caracteres.';
  else if (pix.tipo === 'cpf' && !/^[\d.\s-]+$/.test(pix.chave)) erros.chave = 'Use apenas números e pontuação de CPF na chave PIX.';
  else if (pix.tipo === 'cpf' && !cpfValido(pix.chave)) erros.chave = 'Informe um CPF válido com 11 dígitos.';
  else if (pix.tipo === 'cnpj' && !/^[\d./\s-]+$/.test(pix.chave)) erros.chave = 'Use apenas números e pontuação de CNPJ na chave PIX.';
  else if (pix.tipo === 'cnpj' && !cnpjValido(pix.chave)) erros.chave = 'Informe um CNPJ válido com 14 dígitos.';
  else if (pix.tipo === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(pix.chave)) erros.chave = 'Informe um e-mail válido para a chave PIX.';
  else if (pix.tipo === 'telefone' && !/^\+?[\d\s().-]+$/.test(pix.chave)) erros.chave = 'Use apenas código do país, DDD e número na chave de telefone.';
  else if (pix.tipo === 'telefone' && (digitosPix(pix.chave).length < 10 || digitosPix(pix.chave).length > 13)) erros.chave = 'Informe um telefone PIX válido, com DDD e, se houver, código do país.';
  else if (pix.tipo === 'aleatoria' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pix.chave)) erros.chave = 'Informe uma chave aleatória PIX válida no formato UUID.';

  const mensagens = [...new Set(Object.values(erros))];
  return { valido: mensagens.length === 0, pix, erros, mensagem: mensagens.join(' ') };
}

export function configPixComAliases(config = {}) {
  const pix = normalizarConfigPix(config);
  return {
    pix,
    nomeFavorecido: pix.nomeFavorecido,
    chavePix: pix.chave,
    tipoChavePix: pix.tipo,
  };
}

const pixInicial = normalizarConfigPix({});

const NOMES_PROVEDORES_IA = Object.freeze({ gemini: 'Google Gemini', openai: 'OpenAI' });

function provedorIaPublico(dados = {}, anterior = {}) {
  return {
    configurado: Boolean(dados.configurado ?? anterior.configurado ?? false),
    sufixo: String(dados.sufixo ?? anterior.sufixo ?? '').trim().slice(-4),
    modelo: String(dados.modelo ?? anterior.modelo ?? '').trim() || null,
    erro: String(dados.erro ?? dados.error ?? anterior.erro ?? '').trim(),
  };
}

function estadoGeminiInicial() {
  return {
    disponivel: false,
    provedor: 'gemini',
    provedorNome: NOMES_PROVEDORES_IA.gemini,
    modelo: null,
    erroConfiguracao: '',
    provedores: {
      gemini: provedorIaPublico(),
      openai: provedorIaPublico(),
    },
    relatorio: '',
    diagnostico: '',
    conversa: [],
  };
}

export const estado = {
  conexaoWhatsapp: { status: 'desconectado', numero: null, qrDataUrl: null },
  clientes: [],
  produtos: [],
  historico: [],
  importacoes: [],
  sincronizacao: null,
  consumer: { resumo: null, importacoes: [], vinculacao: null, erro: '' },
  config: {
    pix: pixInicial,
    nomeFavorecido: pixInicial.nomeFavorecido,
    chavePix: pixInicial.chave,
    tipoChavePix: pixInicial.tipo,
    intervaloMin: 5,
    intervaloMax: 11,
    templates: [],
  },
  gemini: estadoGeminiInicial(),
  campanhaEmAndamento: null,
  novaCampanhaTipoInicial: null,
  rascunhoCampanhaIA: null,
};

export function aplicarBootstrap(dados = {}) {
  estado.clientes = Array.isArray(dados.clientes) ? dados.clientes : [];
  estado.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
  estado.historico = Array.isArray(dados.relatorios) ? dados.relatorios : [];
  estado.importacoes = Array.isArray(dados.importacoes) ? dados.importacoes : [];
  estado.sincronizacao = dados.sincronizacao || null;
  estado.consumer = dados.consumer && typeof dados.consumer === 'object'
    ? dados.consumer
    : { resumo: null, importacoes: [], vinculacao: null, erro: '' };
  const configuracoes = dados.configuracoes && typeof dados.configuracoes === 'object' ? dados.configuracoes : {};
  const pix = normalizarConfigPix(configuracoes);
  estado.config = {
    intervaloMin: 5,
    intervaloMax: 11,
    ...configuracoes,
    ...configPixComAliases(pix),
    templates: Array.isArray(dados.templates) ? dados.templates : [],
  };
  estado.conexaoWhatsapp = { ...estado.conexaoWhatsapp, ...(dados.whatsapp || {}) };
  atualizarEstadoGemini(dados.gemini || {});
}

export function atualizarEstadoGemini(dados = {}) {
  const anterior = estado.gemini || estadoGeminiInicial();
  const entrada = dados && typeof dados === 'object' ? dados : {};
  const provedor = ['gemini', 'openai'].includes(entrada.provedor)
    ? entrada.provedor
    : (['gemini', 'openai'].includes(anterior.provedor) ? anterior.provedor : 'gemini');
  const provedoresEntrada = entrada.provedores && typeof entrada.provedores === 'object'
    ? entrada.provedores
    : {};
  const provedoresAnteriores = anterior.provedores || {};
  const provedores = {
    gemini: provedorIaPublico(provedoresEntrada.gemini, provedoresAnteriores.gemini),
    openai: provedorIaPublico(provedoresEntrada.openai, provedoresAnteriores.openai),
  };
  const disponivel = Boolean(entrada.disponivel ?? anterior.disponivel ?? false);
  const modelo = String(
    entrada.modelo
    ?? provedores[provedor].modelo
    ?? anterior.modelo
    ?? '',
  ).trim() || null;

  if (disponivel && !Object.hasOwn(provedoresEntrada, provedor)) {
    provedores[provedor] = { ...provedores[provedor], configurado: true, modelo };
  }

  estado.gemini = {
    disponivel,
    provedor,
    provedorNome: String(entrada.provedorNome || NOMES_PROVEDORES_IA[provedor]),
    modelo,
    erroConfiguracao: String(entrada.erroConfiguracao ?? anterior.erroConfiguracao ?? '').trim(),
    provedores,
    relatorio: String(entrada.relatorio ?? anterior.relatorio ?? ''),
    diagnostico: String(entrada.diagnostico ?? anterior.diagnostico ?? ''),
    conversa: Array.isArray(entrada.conversa)
      ? entrada.conversa
      : (Array.isArray(anterior.conversa) ? anterior.conversa : []),
  };
  return estado.gemini;
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
