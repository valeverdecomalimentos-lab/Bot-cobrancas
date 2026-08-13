import {
  TIPOS_CHAVE_PIX,
  aplicarBootstrap,
  atualizarEstadoGemini,
  configPixComAliases,
  estado,
  normalizarConfigPix,
  validarConfigPix,
} from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const PROVEDORES_IA = Object.freeze({
  gemini: {
    nome: 'Google Gemini',
    sigla: 'G',
    descricao: 'Integração multimodal do Google para análises operacionais.',
    placeholder: 'Cole sua chave Gemini',
    modelos: [
      { valor: 'gemini-3.6-flash', rotulo: 'Gemini 3.6 Flash', detalhe: 'Mais recente' },
      { valor: 'gemini-3.5-flash', rotulo: 'Gemini 3.5 Flash', detalhe: 'Estável' },
    ],
  },
  openai: {
    nome: 'OpenAI',
    sigla: 'O',
    descricao: 'Modelos especializados para velocidade, economia ou raciocínio máximo.',
    placeholder: 'Cole sua chave OpenAI',
    modelos: [
      { valor: 'gpt-5.6-terra', rotulo: 'GPT-5.6 Terra', detalhe: 'Recomendado' },
      { valor: 'gpt-5.6-luna', rotulo: 'GPT-5.6 Luna', detalhe: 'Econômico' },
      { valor: 'gpt-5.6-sol', rotulo: 'GPT-5.6 Sol', detalhe: 'Máximo' },
    ],
  },
});

const ETAPAS_BACKUP = Object.freeze({
  baixando: 'Baixando o backup do Google Drive…',
  download: 'Baixando o backup do Google Drive…',
  downloading: 'Baixando o backup do Google Drive…',
  listando: 'Localizando o backup mais recente da pasta…',
  listing: 'Localizando o backup mais recente da pasta…',
  validando: 'Validando o arquivo de backup…',
  validacao: 'Validando o arquivo de backup…',
  validating: 'Validando o arquivo de backup…',
  restaurando: 'Restaurando uma cópia temporária…',
  restauracao: 'Restaurando uma cópia temporária…',
  restoring: 'Restaurando uma cópia temporária…',
  extraindo: 'Lendo clientes, pedidos, produtos e pagamentos…',
  extracao: 'Lendo clientes, pedidos, produtos e pagamentos…',
  extracting: 'Lendo clientes, pedidos, produtos e pagamentos…',
  gravando: 'Atualizando a base analítica local…',
  persistencia: 'Atualizando a base analítica local…',
  persisting: 'Atualizando a base analítica local…',
  'calculando-perfis': 'Recalculando os perfis completos dos clientes…',
  limpando: 'Removendo os arquivos temporários…',
  concluido: 'Importação concluída.',
  completed: 'Importação concluída.',
});

export function validarLinkBackupGoogleDrive(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return { valido: false, erro: 'Cole o link compartilhado do arquivo ou da pasta de backups.' };
  if (texto.length > 2048) return { valido: false, erro: 'O link informado é muito longo.' };

  let url;
  try {
    url = new URL(texto);
  } catch {
    return { valido: false, erro: 'Informe um link válido do Google Drive.' };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.protocol !== 'https:' || host !== 'drive.google.com') {
    return { valido: false, erro: 'Use um link HTTPS compartilhado pelo Google Drive.' };
  }

  const idPasta = url.pathname.match(/\/(?:drive(?:\/u\/\d+)?\/)?folders\/([^/]+)/i)?.[1];
  if (idPasta) return { valido: true, tipo: 'pasta', id: idPasta, url: url.toString(), erro: '' };

  const idArquivo = url.pathname.match(/\/file\/d\/([^/]+)/i)?.[1]
    || url.searchParams.get('id');
  if (idArquivo) return { valido: true, tipo: 'arquivo', id: idArquivo, url: url.toString(), erro: '' };

  return { valido: false, erro: 'Não foi possível identificar um arquivo ou uma pasta nesse link do Google Drive.' };
}

function numeroImportacao(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function valorNoCaminho(origem, caminho) {
  return caminho.split('.').reduce((valor, chave) => valor?.[chave], origem);
}

function contagemDoValor(valor) {
  if (Array.isArray(valor)) return valor.length;
  if (valor && typeof valor === 'object') {
    for (const chave of ['total', 'quantidade', 'importados', 'count']) {
      if (Object.hasOwn(valor, chave)) return contagemDoValor(valor[chave]);
    }
    return null;
  }
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, numero) : null;
}

function primeiraContagem(resultado, caminhos) {
  for (const caminho of caminhos) {
    const contagem = contagemDoValor(valorNoCaminho(resultado, caminho));
    if (contagem !== null) return contagem;
  }
  return null;
}

function nomeArquivoSeguro(valor) {
  return String(valor || '').split(/[\\/]/).pop().trim();
}

function sincronizacaoConsumerAtual() {
  const candidatos = [
    estado.consumer?.sincronizacao,
    estado.consumer?.sincronizacaoDrive,
    estado.consumer?.sync,
    estado.config?.consumerBackupSync,
    estado.config?.sincronizacaoConsumer,
    estado.config?.backupConsumer,
  ];
  return candidatos.find((item) => item && typeof item === 'object') || {};
}

function urlPastaSalva() {
  const sync = sincronizacaoConsumerAtual();
  return String(sync.url || sync.folderUrl || sync.pastaUrl || sync.link || '').trim();
}

function formatarDataSincronizacao(valor) {
  const instante = Date.parse(String(valor || ''));
  if (!Number.isFinite(instante)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(instante).replace(',', ' às');
}

function montarFontesDados(tela) {
  const fontes = tela.querySelector('#fontes-importacao');
  const botaoArquivoLocal = tela.querySelector('[data-arquivo-local]');
  const botaoBackupLink = tela.querySelector('[data-backup-link]');
  const formularioLink = tela.querySelector('#form-backup-drive');
  const campoLink = tela.querySelector('#campo-link-backup');
  const ajudaLink = tela.querySelector('#ajuda-link-backup');
  const erroLink = tela.querySelector('#erro-link-backup');
  const areaAndamento = tela.querySelector('#andamento-importacao');
  const textoAndamento = tela.querySelector('#texto-andamento');
  const percentualAndamento = tela.querySelector('#percentual-andamento');
  const barraAndamento = tela.querySelector('#barra-importacao');
  const areaResultado = tela.querySelector('#resultado-importacao');
  const statusSincronizacao = tela.querySelector('#status-sincronizacao-consumer');
  const controles = [botaoArquivoLocal, botaoBackupLink, campoLink];
  let ocupado = false;
  let removendoPasta = false;
  let tipoEmAndamento = '';
  let botaoEmAndamento = null;
  let conteudoOriginalBotao = '';

  function limparErroLink() {
    erroLink.hidden = true;
    erroLink.textContent = '';
    campoLink.removeAttribute('aria-invalid');
  }

  function mostrarErroLink(mensagem) {
    erroLink.textContent = mensagem;
    erroLink.hidden = false;
    campoLink.setAttribute('aria-invalid', 'true');
    campoLink.focus();
  }

  function renderizarStatusSincronizacao(resultado = null) {
    const sync = sincronizacaoConsumerAtual();
    const data = formatarDataSincronizacao(
      resultado?.sincronizadoEm || resultado?.syncedAt || resultado?.importadoEm
      || sync.ultimaSincronizacao || sync.lastSyncedAt || sync.sincronizadoEm || sync.updatedAt,
    );
    const arquivo = nomeArquivoSeguro(
      resultado?.arquivo || resultado?.nomeArquivo
      || sync.ultimoArquivo || sync.latestFileName || sync.lastFileName || sync.arquivo,
    );
    const pastaConfigurada = !resultado?.removida && Boolean(
      resultado?.pastaSalva || resultado?.folderSaved || resultado?.folderUrl
      || urlPastaSalva() || sync.salva || sync.saved || sync.ativa || sync.enabled,
    );
    statusSincronizacao.innerHTML = `
      <span class="status-fonte-dados__indicador ${pastaConfigurada ? 'status-fonte-dados__indicador--ativo' : ''}" aria-hidden="true"></span>
      <div>
        <strong>${pastaConfigurada ? 'Pasta do Google Drive configurada' : 'Sincronização automática ainda não configurada'}</strong>
        <p>${data ? `Última sincronização: ${escaparHtml(data)}${arquivo ? ` · ${escaparHtml(arquivo)}` : ''}.` : 'Cole o link de uma pasta para salvar a fonte e buscar sempre o backup mais recente.'}</p>
        ${pastaConfigurada ? '<button class="status-fonte-dados__remover" type="button" data-remover-pasta-sync>Remover pasta sincronizada</button>' : ''}
      </div>`;
  }

  function atualizarModoLink() {
    limparErroLink();
    const parecePasta = /\/folders\//i.test(campoLink.value);
    botaoBackupLink.textContent = parecePasta ? 'Salvar e sincronizar agora' : 'Importar arquivo';
    ajudaLink.innerHTML = parecePasta
      ? '<strong>Pasta recomendada:</strong> ela ficará salva e cada sincronização usará o backup compatível mais recente.'
      : 'Aceita arquivo específico em formato compatível ou uma pasta de backups. Prefira a pasta para manter os perfis atualizados.';
  }

  function atualizarProgresso(progresso = {}) {
    if (!ocupado || !['arquivo', 'url', 'pasta'].includes(tipoEmAndamento)) return;
    areaAndamento.hidden = false;
    const etapa = String(progresso.etapa || progresso.stage || progresso.status || '').toLowerCase();
    const mensagem = String(progresso.mensagem || progresso.message || ETAPAS_BACKUP[etapa] || 'Processando o backup…');
    const valorBruto = progresso.percentual ?? progresso.percent ?? progresso.progresso;
    const numero = valorBruto === null || valorBruto === undefined || valorBruto === '' ? null : Number(valorBruto);
    const percentual = Number.isFinite(numero) ? Math.min(100, Math.max(0, Math.round(numero))) : null;
    textoAndamento.textContent = mensagem;
    if (percentual === null) {
      percentualAndamento.textContent = '';
      barraAndamento.classList.add('importacao-barra--indeterminada');
      barraAndamento.removeAttribute('aria-valuenow');
      barraAndamento.querySelector('i').style.width = '';
    } else {
      percentualAndamento.textContent = `${percentual}%`;
      barraAndamento.classList.remove('importacao-barra--indeterminada');
      barraAndamento.setAttribute('aria-valuemin', '0');
      barraAndamento.setAttribute('aria-valuemax', '100');
      barraAndamento.setAttribute('aria-valuenow', String(percentual));
      barraAndamento.querySelector('i').style.width = `${percentual}%`;
    }
  }

  function definirOcupado(novoEstado, tipo = '', botao = null) {
    ocupado = novoEstado;
    tipoEmAndamento = novoEstado ? tipo : '';
    fontes.setAttribute('aria-busy', String(novoEstado));
    controles.forEach((controle) => { controle.disabled = novoEstado; });
    if (novoEstado && botao) {
      botaoEmAndamento = botao;
      conteudoOriginalBotao = botao.innerHTML;
      botao.setAttribute('aria-busy', 'true');
      botao.textContent = tipo === 'pasta'
        ? 'Sincronizando pasta…'
        : (tipo === 'arquivo' ? 'Selecionando e importando…' : 'Importando dados…');
    } else if (botaoEmAndamento) {
      botaoEmAndamento.innerHTML = conteudoOriginalBotao;
      botaoEmAndamento.removeAttribute('aria-busy');
      botaoEmAndamento = null;
      conteudoOriginalBotao = '';
      atualizarModoLink();
    }
  }

  async function atualizarDadosDaTela(resultado) {
    try {
      const dados = await api.bootstrap();
      if (dados && typeof dados === 'object') aplicarBootstrap(dados);
    } catch {
      // A importação foi persistida; o próximo bootstrap atualizará os indicadores.
    }
    renderizarStatusSincronizacao(resultado);
  }

  function renderizarResultadoTabela(resultado) {
    const arquivo = nomeArquivoSeguro(resultado.arquivo) || 'Arquivo importado';
    const tipoImportacao = String(resultado.tipoImportacao || resultado.tipo || '').toLowerCase();
    const importaProdutos = tipoImportacao === 'produtos';
    const metricas = importaProdutos
      ? [
        [numeroImportacao(resultado.processados ?? resultado.created ?? resultado.importados), 'listas processadas'],
        [numeroImportacao(resultado.ignorados ?? resultado.invalidos), 'inalteradas'],
        [numeroImportacao(resultado.erros), 'com erro'],
        [numeroImportacao(resultado.totalProdutos ?? resultado.produtos), 'produtos disponíveis'],
      ]
      : [
        [numeroImportacao(resultado.created), 'novos'],
        [numeroImportacao(resultado.updated), 'atualizados'],
        [numeroImportacao(resultado.totalLido), 'linhas lidas'],
        [numeroImportacao(resultado.invalidos), 'ignoradas'],
      ];
    areaResultado.innerHTML = `
      <div class="resultado-importacao__cartao resultado-importacao__cartao--sucesso">
        <div class="resultado-importacao__titulo">${Icone.check}<div><strong>${importaProdutos ? 'Cadastro de produtos atualizado' : 'Base de clientes atualizada'}</strong><p>${escaparHtml(arquivo)} (${escaparHtml(resultado.formato || 'formato identificado')})</p></div></div>
        <div class="resultado-importacao__metricas">${metricas.map(([valor, rotulo]) => `<div><strong>${valor.toLocaleString('pt-BR')}</strong><span>${escaparHtml(rotulo)}</span></div>`).join('')}</div>
      </div>`;
  }

  function renderizarResultadoBackup(resultado, sincronizouPasta) {
    const definicoes = [
      ['Clientes', ['resumo.clientes', 'resumo.totalClientes', 'clientesImportados', 'totalClientes', 'clientes']],
      ['Pedidos', ['resumo.pedidos', 'resumo.compras', 'pedidosImportados', 'totalPedidos', 'pedidos']],
      ['Itens', ['resumo.itens', 'itensImportados', 'totalItens', 'itens']],
      ['Pagamentos', ['resumo.pagamentos', 'pagamentosImportados', 'totalPagamentos', 'pagamentos']],
      ['Produtos', ['resumo.produtos', 'produtosImportados', 'totalProdutos', 'produtos']],
      ['Entregas', ['resumo.entregas', 'entregasImportadas', 'totalEntregas', 'entregas']],
      ['Lançamentos no fiado', ['resumo.contaCorrente', 'contaCorrenteImportada', 'totalContaCorrente', 'contaCorrente']],
      ['Perfis calculados', ['resumo.perfis', 'perfisCalculados', 'totalPerfis', 'perfis']],
    ];
    const metricas = definicoes
      .map(([rotulo, caminhos]) => [rotulo, primeiraContagem(resultado, caminhos)])
      .filter(([, quantidade]) => quantidade !== null);
    const arquivo = nomeArquivoSeguro(resultado.arquivo || resultado.nomeArquivo) || 'Arquivo de dados importado';
    const avisos = Array.isArray(resultado.avisos) ? resultado.avisos.filter(Boolean) : (resultado.aviso ? [resultado.aviso] : []);
    const status = String(resultado.status || '').toLowerCase();
    const duplicado = ['duplicada', 'duplicado', 'duplicate'].includes(status);
    const atualizado = ['atualizada', 'up_to_date'].includes(status);
    const anterior = ['anterior', 'older'].includes(status);
    const titulo = atualizado
      ? 'A pasta já está sincronizada com o backup mais recente'
      : anterior
        ? 'O arquivo é anterior ao backup já sincronizado'
        : duplicado
      ? 'O backup mais recente já estava importado'
      : (sincronizouPasta ? 'Pasta sincronizada com sucesso' : 'Backup importado com sucesso');
    areaResultado.innerHTML = `
      <div class="resultado-importacao__cartao resultado-importacao__cartao--sucesso">
        <div class="resultado-importacao__titulo">${Icone.check}<div><strong>${titulo}</strong><p>${escaparHtml(arquivo)}${duplicado || atualizado ? ' — nenhuma informação foi duplicada.' : anterior ? ' — os dados mais novos foram mantidos.' : ''}</p></div></div>
        ${metricas.length ? `<div class="resultado-importacao__metricas">${metricas.map(([rotulo, quantidade]) => `<div><strong>${quantidade.toLocaleString('pt-BR')}</strong><span>${escaparHtml(rotulo)}</span></div>`).join('')}</div>` : '<p class="resultado-importacao__mensagem">Os dados disponíveis foram incorporados à base analítica local.</p>'}
        ${avisos.length ? `<ul class="resultado-importacao__avisos">${avisos.map((aviso) => `<li>${escaparHtml(aviso)}</li>`).join('')}</ul>` : ''}
      </div>`;
  }

  function renderizarFalha(mensagem) {
    areaResultado.innerHTML = `
      <div class="resultado-importacao__cartao resultado-importacao__cartao--erro" role="alert">
        <div class="resultado-importacao__titulo">${Icone.aviso}<div><strong>Não foi possível concluir a importação</strong><p>${escaparHtml(mensagem)}</p></div></div>
      </div>`;
  }

  async function executarImportacao({ tipo, botao, chamar }) {
    if (ocupado) return;
    limparErroLink();
    areaResultado.innerHTML = '';
    definirOcupado(true, tipo, botao);
    let cancelarProgresso = () => {};
    atualizarProgresso({
      mensagem: tipo === 'pasta' ? 'Localizando o backup mais recente da pasta…' : 'Preparando o arquivo para importação…',
    });
    cancelarProgresso = api.onConsumerBackupProgress(atualizarProgresso);
    try {
      const resultado = await chamar();
      if (resultado?.cancelado) {
        areaAndamento.hidden = true;
        return;
      }
      atualizarProgresso({ etapa: 'concluido', percentual: 100 });
      await atualizarDadosDaTela(resultado);
      const tipoImportacao = String(resultado?.tipoImportacao || resultado?.tipo || '').toLowerCase();
      const importacaoTabular = ['clientes', 'produtos'].includes(tipoImportacao)
        || (!tipoImportacao && Boolean(resultado?.formato));
      const sincronizouPasta = resultado?.tipoFonte === 'drive-folder' || tipo === 'pasta';
      if (importacaoTabular) renderizarResultadoTabela(resultado || {});
      else renderizarResultadoBackup(resultado || {}, sincronizouPasta);
      if (['url', 'pasta'].includes(tipo)) {
        campoLink.value = '';
        atualizarModoLink();
      }
      const statusResultado = String(resultado?.status || '').toLowerCase();
      const duplicado = ['duplicada', 'duplicado', 'duplicate'].includes(statusResultado);
      const atualizado = ['atualizada', 'up_to_date'].includes(statusResultado);
      const anterior = ['anterior', 'older'].includes(statusResultado);
      mostrarToast(
        atualizado ? 'A pasta já está atualizada'
          : anterior ? 'O backup mais novo foi mantido'
          : duplicado ? 'O backup mais recente já estava na base'
          : (importacaoTabular
            ? (tipoImportacao === 'produtos' ? 'Cadastro de produtos atualizado' : 'Base de clientes atualizada')
            : sincronizouPasta ? 'Pasta de backups sincronizada' : 'Histórico do Consumer importado'),
        'sucesso',
      );
    } catch (error) {
      areaAndamento.hidden = true;
      const mensagem = motivoErroApi(error, 'Não foi possível importar o arquivo.');
      renderizarFalha(mensagem);
      mostrarToast(mensagem, 'erro');
    } finally {
      cancelarProgresso();
      definirOcupado(false);
    }
  }

  botaoArquivoLocal.addEventListener('click', () => executarImportacao({
    tipo: 'arquivo',
    botao: botaoArquivoLocal,
    chamar: () => api.importDataFile(),
  }));
  formularioLink.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const validacao = validarLinkBackupGoogleDrive(campoLink.value);
    if (!validacao.valido) {
      mostrarErroLink(validacao.erro);
      return;
    }
    executarImportacao({
      tipo: validacao.tipo === 'pasta' ? 'pasta' : 'url',
      botao: botaoBackupLink,
      chamar: () => api.importDataFromUrl(validacao.url),
    });
  });
  campoLink.addEventListener('input', atualizarModoLink);
  statusSincronizacao.addEventListener('click', async (evento) => {
    const botaoRemover = evento.target instanceof Element
      ? evento.target.closest('[data-remover-pasta-sync]')
      : null;
    if (!botaoRemover || ocupado || removendoPasta) return;
    const confirmou = window.confirm(
      'Remover a pasta sincronizada do Google Drive? A sincronização automática será desativada, mas nenhum cliente, produto, compra ou pagamento já importado será apagado.',
    );
    if (!confirmou) return;

    removendoPasta = true;
    botaoRemover.disabled = true;
    botaoRemover.setAttribute('aria-busy', 'true');
    botaoRemover.textContent = 'Removendo pasta…';
    controles.forEach((controle) => { controle.disabled = true; });
    try {
      const resultado = await api.removeConsumerBackupFolder();
      const sincronizacao = resultado?.sincronizacao && typeof resultado.sincronizacao === 'object'
        ? resultado.sincronizacao
        : {};
      estado.consumer = { ...(estado.consumer || {}), sincronizacao };
      campoLink.value = '';
      atualizarModoLink();
      renderizarStatusSincronizacao({ removida: true });
      mostrarToast('Pasta removida. Os dados importados foram mantidos.', 'sucesso');
    } catch (error) {
      const mensagem = motivoErroApi(error, 'Não foi possível remover a pasta sincronizada.');
      mostrarToast(mensagem, 'erro');
      if (botaoRemover.isConnected) {
        botaoRemover.disabled = false;
        botaoRemover.removeAttribute('aria-busy');
        botaoRemover.textContent = 'Remover pasta sincronizada';
      }
    } finally {
      removendoPasta = false;
      controles.forEach((controle) => { controle.disabled = false; });
    }
  });
  let cancelarStatusSincronizacao = () => {};
  cancelarStatusSincronizacao = api.onConsumerBackupSyncStatus((sync) => {
    if (!tela.isConnected) {
      cancelarStatusSincronizacao();
      return;
    }
    estado.consumer = { ...(estado.consumer || {}), sincronizacao: sync };
    renderizarStatusSincronizacao();
  });
  api.getConsumerBackupSyncStatus().then((sync) => {
    if (!tela.isConnected || !sync || typeof sync !== 'object') return;
    estado.consumer = { ...(estado.consumer || {}), sincronizacao: sync };
    atualizarModoLink();
    renderizarStatusSincronizacao();
  }).catch(() => undefined);
  atualizarModoLink();
  renderizarStatusSincronizacao();
}

function provedorIaValido(valor) {
  return Object.hasOwn(PROVEDORES_IA, valor) ? valor : 'gemini';
}

function motivoErroApi(error, fallback) {
  const mensagem = String(error?.message || '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(?:Error:\s*)+/i, '')
    .trim();
  return mensagem || fallback;
}

export function montarConfiguracoes(alvo) {
  const pixAtual = normalizarConfigPix(estado.config);
  const opcoesTipoPix = Object.entries(TIPOS_CHAVE_PIX).map(([valor, rotulo]) => (
    `<option value="${valor}" ${pixAtual.tipo === valor ? 'selected' : ''}>${rotulo}</option>`
  )).join('');
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Configurações</h1><p class="legenda">Preferências, integrações e fontes de dados do aplicativo.</p></div></div>
      <section class="cartao secao-config secao-fontes-dados" aria-labelledby="titulo-fontes-dados">
        <div class="secao-config__cabecalho secao-fontes-dados__cabecalho">
          <div>
            <h2 id="titulo-fontes-dados"><span aria-hidden="true">${Icone.atualizar}</span> Fontes de dados</h2>
            <p class="legenda">Atualize cadastros e o histórico completo usado nos perfis de clientes e nas análises da IA.</p>
          </div>
          <div class="status-fonte-dados" id="status-sincronizacao-consumer" aria-live="polite"></div>
        </div>
        <div class="importacao-fontes" id="fontes-importacao">
          <article class="importacao-fonte importacao-fonte--destaque" aria-labelledby="titulo-importar-dados">
            <div class="importacao-fonte__cabecalho">
              <span class="importacao-fonte__icone" aria-hidden="true">${Icone.atualizar}</span>
              <div>
                <span class="badge badge--sucesso">Importação centralizada</span>
                <h4 id="titulo-importar-dados">Importar dados</h4>
                <p>O aplicativo reconhece o formato escolhido e atualiza clientes, produtos ou o histórico completo do Consumer.</p>
              </div>
            </div>
            <button class="btn btn--secundario importacao-fonte__acao" type="button" data-arquivo-local>${Icone.upload} Selecionar arquivo local</button>
            <p class="ajuda-campo">Formatos aceitos: FB, FBCONSUMER, FBK, GBK, BAK, BACKUP, PDF, XLS, XLSX e CSV.</p>
            <div class="importacao-separador" aria-hidden="true"><span>ou conectar ao Drive</span></div>
            <form id="form-backup-drive" novalidate>
              <div class="importacao-link-rotulo">
                <label for="campo-link-backup">Link do arquivo ou da pasta no Google Drive</label>
                <span class="badge badge--sucesso">Pasta recomendada</span>
              </div>
              <div class="importacao-link-linha">
                <input id="campo-link-backup" name="backupUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Cole aqui o link compartilhado" aria-describedby="ajuda-link-backup erro-link-backup">
                <button class="btn btn--primario" type="submit" data-backup-link>Importar arquivo</button>
              </div>
              <p class="ajuda-campo" id="ajuda-link-backup">Aceita arquivo específico em formato compatível ou uma pasta de backups. Prefira a pasta para manter os perfis atualizados.</p>
              <p class="erro-campo" id="erro-link-backup" role="alert" hidden></p>
            </form>
          </article>
        </div>
        <div class="importacao-andamento" id="andamento-importacao" aria-live="polite" aria-atomic="true" hidden>
          <div class="importacao-andamento__texto"><strong id="texto-andamento">Preparando importação…</strong><span id="percentual-andamento"></span></div>
          <div class="importacao-barra" id="barra-importacao" role="progressbar" aria-label="Progresso da importação"><i></i></div>
          <p>Não feche o aplicativo enquanto os dados estão sendo processados.</p>
        </div>
        <div id="resultado-importacao" class="resultado-importacao" role="status" aria-live="polite" aria-atomic="true"></div>
      </section>
      <section class="cartao secao-config secao-config--ia" aria-labelledby="titulo-config-ia">
        <div class="secao-config-ia__topo">
          <div class="secao-config__cabecalho">
            <h2 id="titulo-config-ia"><span aria-hidden="true">${Icone.sparkles}</span> Inteligência artificial</h2>
            <p class="legenda">Escolha o provedor e o modelo do Copiloto. A chave é armazenada com proteção local e nunca volta a ser exibida.</p>
          </div>
          <div id="status-geral-ia" class="status-config-ia" aria-live="polite"></div>
        </div>
        <div id="controles-config-ia"></div>
      </section>
      <div class="grade-config">
        <div>
          <div class="cartao secao-config">
            <div class="secao-config__cabecalho">
              <h3>${Icone.cifrao} Dados para recebimento via PIX</h3>
              <p class="legenda">Esses dados substituem automaticamente os placeholders dos templates de cobrança.</p>
            </div>
            <div class="grade-campos grade-campos--pix">
              <div class="campo">
                <label for="campo-pix-favorecido">Nome do favorecido</label>
                <input type="text" id="campo-pix-favorecido" autocomplete="name" maxlength="120" aria-describedby="ajuda-pix-favorecido erro-pix-favorecido" value="${escaparHtml(pixAtual.nomeFavorecido)}" placeholder="Nome como aparece na conta">
                <small id="ajuda-pix-favorecido">Use o nome do titular da conta que receberá o pagamento.</small>
                <small id="erro-pix-favorecido" class="erro-campo" role="alert" hidden></small>
              </div>
              <div class="campo">
                <label for="campo-pix-tipo">Tipo de chave</label>
                <select id="campo-pix-tipo" aria-describedby="ajuda-pix-tipo">${opcoesTipoPix}</select>
                <small id="ajuda-pix-tipo">Escolha o tipo correto para validarmos a chave antes do envio.</small>
              </div>
              <div class="campo campo--largura-total">
                <label for="campo-pix-chave">Chave PIX</label>
                <input type="text" id="campo-pix-chave" autocomplete="off" spellcheck="false" maxlength="140" aria-describedby="ajuda-pix-chave erro-pix-chave" value="${escaparHtml(pixAtual.chave)}">
                <small id="ajuda-pix-chave"></small>
                <small id="erro-pix-chave" class="erro-campo" role="alert" hidden></small>
              </div>
            </div>
            <div class="resumo-config-pix" aria-live="polite">
              <span class="resumo-config-pix__rotulo">Prévia nos avisos de cobrança</span>
              <strong id="previa-pix-favorecido"></strong>
              <span id="previa-pix-chave"></span>
            </div>
          </div>
          <div class="cartao secao-config">
            <h3>${Icone.relogio} Intervalo entre mensagens</h3>
            <div class="campo"><label for="slider-min">Mínimo: <span id="rotulo-min">${estado.config.intervaloMin}s</span></label><div class="slider-wrap"><input type="range" id="slider-min" min="3" max="60" value="${estado.config.intervaloMin}"></div></div>
            <div class="campo"><label for="slider-max">Máximo: <span id="rotulo-max">${estado.config.intervaloMax}s</span></label><div class="slider-wrap"><input type="range" id="slider-max" min="3" max="120" value="${estado.config.intervaloMax}"></div></div>
          </div>
          <div class="acoes-config"><button class="btn btn--primario" id="btn-salvar-config">Salvar configurações</button></div>
        </div>
        <div><div class="cartao secao-config"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><h3>${Icone.editar} Templates salvos</h3><div style="display:flex;gap:6px"><button class="btn btn--fantasma" id="btn-importar-template" type="button" aria-label="Importar template TXT" title="Importar template TXT">${Icone.upload}</button><button class="btn btn--fantasma" id="btn-novo-template" type="button" aria-label="Criar novo template" title="Novo template">${Icone.adicionar}</button></div></div><div id="lista-templates"></div></div></div>
      </div>
    </div>`);
  alvo.appendChild(tela);
  montarFontesDados(tela);
  const campoPixFavorecido = tela.querySelector('#campo-pix-favorecido');
  const campoPixTipo = tela.querySelector('#campo-pix-tipo');
  const campoPixChave = tela.querySelector('#campo-pix-chave');
  const sliderMin = tela.querySelector('#slider-min');
  const sliderMax = tela.querySelector('#slider-max');
  const botaoSalvar = tela.querySelector('#btn-salvar-config');
  const controlesConfigIa = tela.querySelector('#controles-config-ia');
  const statusGeralIa = tela.querySelector('#status-geral-ia');
  let provedorSelecionado = provedorIaValido(estado.gemini.provedor);
  let operacaoIa = '';
  let erroStatusIa = '';

  function dadosPublicosProvedor(provedor) {
    return estado.gemini.provedores?.[provedor] || { configurado: false, sufixo: '', modelo: null };
  }

  function atualizarStatusGeralIa() {
    if (estado.gemini.erroConfiguracao) {
      statusGeralIa.innerHTML = `<span class="badge badge--erro">Cofre indisponível</span><small>${escaparHtml(estado.gemini.erroConfiguracao)}</small>`;
      return;
    }
    if (estado.gemini.disponivel) {
      const nome = estado.gemini.provedorNome || PROVEDORES_IA[provedorIaValido(estado.gemini.provedor)].nome;
      statusGeralIa.innerHTML = `<span class="badge badge--sucesso">Copiloto ativo</span><small>${escaparHtml(nome)}${estado.gemini.modelo ? ` · ${escaparHtml(estado.gemini.modelo)}` : ''}</small>`;
      return;
    }
    statusGeralIa.innerHTML = '<span class="badge badge--neutro">Não configurado</span><small>Escolha um provedor para ativar o Copiloto</small>';
  }

  function renderizarConfigIa({ focoNoProvedor = false } = {}) {
    atualizarStatusGeralIa();
    const definicao = PROVEDORES_IA[provedorSelecionado];
    const credencial = dadosPublicosProvedor(provedorSelecionado);
    const modeloAtual = String(
      credencial.modelo
      || (estado.gemini.provedor === provedorSelecionado ? estado.gemini.modelo : '')
      || definicao.modelos[0].valor,
    );
    const ocupado = Boolean(operacaoIa);
    const credencialTexto = credencial.erro
      ? `Credencial indisponível: ${escaparHtml(credencial.erro)}`
      : credencial.configurado
      ? `Chave configurada${credencial.sufixo ? ` · final •••• ${escaparHtml(credencial.sufixo)}` : ''}`
      : 'Nenhuma chave cadastrada';

    controlesConfigIa.innerHTML = `
      <fieldset class="seletor-provedor-ia" ${ocupado ? 'disabled' : ''}>
        <legend>Provedor do Copiloto</legend>
        <div class="grade-provedores-ia">
          ${Object.entries(PROVEDORES_IA).map(([id, provedor]) => {
            const dados = dadosPublicosProvedor(id);
            return `<label class="opcao-provedor-ia ${id === provedorSelecionado ? 'selecionada' : ''}">
              <input type="radio" name="provedor-ia" value="${id}" ${id === provedorSelecionado ? 'checked' : ''} aria-describedby="descricao-provedor-${id}">
              <span class="marca-provedor-ia" aria-hidden="true">${provedor.sigla}</span>
              <span class="opcao-provedor-ia__texto"><strong>${provedor.nome}</strong><small id="descricao-provedor-${id}">${provedor.descricao}</small></span>
              <span class="estado-provedor-ia ${dados.configurado && !dados.erro ? 'configurado' : ''}">${dados.erro ? 'Verificar cofre' : dados.configurado ? `Configurado${dados.sufixo ? ` · •••• ${escaparHtml(dados.sufixo)}` : ''}` : 'Configurar'}</span>
            </label>`;
          }).join('')}
        </div>
      </fieldset>
      <div class="config-ia-formulario">
        <div class="campo">
          <label for="campo-modelo-ia">Modelo</label>
          <select id="campo-modelo-ia" ${ocupado ? 'disabled' : ''}>
            ${definicao.modelos.map((modelo) => `<option value="${modelo.valor}" ${modelo.valor === modeloAtual ? 'selected' : ''}>${modelo.rotulo} — ${modelo.detalhe}</option>`).join('')}
          </select>
          <small>Você pode trocar o modelo sem informar novamente uma chave já configurada.</small>
        </div>
        <div class="campo">
          <label for="campo-chave-ia">Chave de API</label>
          <div class="campo-chave-ia">
            <input type="password" id="campo-chave-ia" autocomplete="new-password" spellcheck="false" maxlength="512" placeholder="${credencial.configurado ? 'Deixe vazio para manter a chave atual' : definicao.placeholder}" aria-describedby="ajuda-chave-ia erro-chave-ia" ${ocupado ? 'disabled' : ''}>
            <button class="btn btn--fantasma alternar-chave-ia" id="btn-alternar-chave-ia" type="button" aria-controls="campo-chave-ia" aria-pressed="false" ${ocupado ? 'disabled' : ''}>Mostrar</button>
          </div>
          <small id="ajuda-chave-ia"><span class="indicador-credencial-ia ${credencial.configurado ? 'configurada' : ''}">${credencialTexto}</span>. Uma chave vazia preserva a credencial existente.</small>
          <small id="erro-chave-ia" class="erro-campo" role="alert" ${erroStatusIa ? '' : 'hidden'}>${escaparHtml(erroStatusIa)}</small>
        </div>
      </div>
      <div class="acoes-config-ia">
        ${credencial.configurado ? '<button class="btn btn--fantasma btn-remover-credencial" id="btn-remover-chave-ia" type="button">Remover chave</button>' : '<span></span>'}
        <button class="btn btn--primario" id="btn-salvar-ia" type="button" ${ocupado ? 'disabled aria-disabled="true" aria-busy="true"' : ''}>${operacaoIa === 'salvando' ? 'Testando conexão...' : operacaoIa === 'removendo' ? 'Atualizando...' : 'Aplicar e testar conexão'}</button>
      </div>`;

    controlesConfigIa.querySelectorAll('input[name="provedor-ia"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        provedorSelecionado = provedorIaValido(radio.value);
        erroStatusIa = '';
        renderizarConfigIa({ focoNoProvedor: true });
      });
    });

    const campoChave = controlesConfigIa.querySelector('#campo-chave-ia');
    const botaoAlternarChave = controlesConfigIa.querySelector('#btn-alternar-chave-ia');
    campoChave?.addEventListener('input', () => {
      erroStatusIa = '';
      campoChave.removeAttribute('aria-invalid');
      const erro = controlesConfigIa.querySelector('#erro-chave-ia');
      if (erro) {
        erro.hidden = true;
        erro.textContent = '';
      }
    });
    botaoAlternarChave?.addEventListener('click', () => {
      const revelar = campoChave.type === 'password';
      campoChave.type = revelar ? 'text' : 'password';
      botaoAlternarChave.textContent = revelar ? 'Ocultar' : 'Mostrar';
      botaoAlternarChave.setAttribute('aria-pressed', String(revelar));
      botaoAlternarChave.setAttribute('aria-label', `${revelar ? 'Ocultar' : 'Mostrar'} chave de API`);
      campoChave.focus();
    });

    controlesConfigIa.querySelector('#btn-salvar-ia')?.addEventListener('click', async () => {
      const apiKey = campoChave.value.trim();
      const credencialAtual = dadosPublicosProvedor(provedorSelecionado);
      if (!apiKey && !credencialAtual.configurado) {
        erroStatusIa = `Informe uma chave de API da ${PROVEDORES_IA[provedorSelecionado].nome}.`;
        campoChave.setAttribute('aria-invalid', 'true');
        const erro = controlesConfigIa.querySelector('#erro-chave-ia');
        erro.textContent = erroStatusIa;
        erro.hidden = false;
        campoChave.focus();
        return;
      }

      operacaoIa = 'salvando';
      erroStatusIa = '';
      const provider = provedorSelecionado;
      const model = controlesConfigIa.querySelector('#campo-modelo-ia').value;
      renderizarConfigIa();
      try {
        const status = await api.saveAiSettings({ provider, model, apiKey });
        atualizarEstadoGemini(status);
        provedorSelecionado = provedorIaValido(status?.provedor || provider);
        mostrarToast(`${PROVEDORES_IA[provider].nome} conectado ao Copiloto.`, 'sucesso');
      } catch (error) {
        erroStatusIa = motivoErroApi(error, 'Não foi possível validar esta chave. Confira a credencial e tente novamente.');
        mostrarToast(erroStatusIa, 'erro');
      } finally {
        operacaoIa = '';
        if (tela.isConnected) renderizarConfigIa();
      }
    });

    controlesConfigIa.querySelector('#btn-remover-chave-ia')?.addEventListener('click', async () => {
      const provider = provedorSelecionado;
      if (!window.confirm(`Remover a chave da ${PROVEDORES_IA[provider].nome}? O Copiloto deixará de usar esse provedor.`)) return;
      operacaoIa = 'removendo';
      erroStatusIa = '';
      renderizarConfigIa();
      try {
        atualizarEstadoGemini(await api.removeAiCredential(provider));
        mostrarToast(`Chave da ${PROVEDORES_IA[provider].nome} removida.`, 'sucesso');
      } catch (error) {
        erroStatusIa = motivoErroApi(error, 'Não foi possível remover a chave.');
        mostrarToast(erroStatusIa, 'erro');
      } finally {
        operacaoIa = '';
        if (tela.isConnected) renderizarConfigIa();
      }
    });

    if (focoNoProvedor) {
      requestAnimationFrame(() => controlesConfigIa.querySelector(`input[value="${provedorSelecionado}"]`)?.focus());
    }
  }

  renderizarConfigIa();
  if (typeof api.getAiStatus === 'function') {
    api.getAiStatus().then((status) => {
      atualizarEstadoGemini(status);
      provedorSelecionado = provedorIaValido(status?.provedor || provedorSelecionado);
      if (tela.isConnected) renderizarConfigIa();
    }).catch((error) => {
      erroStatusIa = motivoErroApi(error, 'Não foi possível consultar o estado da IA.');
      if (tela.isConnected) renderizarConfigIa();
    });
  }

  const dicasChave = {
    cpf: { placeholder: '000.000.000-00', inputMode: 'numeric', texto: 'Digite os 11 números do CPF; pontuação é opcional.' },
    cnpj: { placeholder: '00.000.000/0000-00', inputMode: 'numeric', texto: 'Digite os 14 números do CNPJ; pontuação é opcional.' },
    email: { placeholder: 'financeiro@empresa.com.br', inputMode: 'email', texto: 'Informe o e-mail completo cadastrado como chave PIX.' },
    telefone: { placeholder: '+55 (22) 99999-9999', inputMode: 'tel', texto: 'Inclua DDD e, de preferência, o código do país (+55).' },
    aleatoria: { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', inputMode: 'text', texto: 'Cole a chave aleatória completa fornecida pelo banco.' },
  };

  function lerPixFormulario() {
    return normalizarConfigPix({
      pix: {
        nomeFavorecido: campoPixFavorecido.value,
        chave: campoPixChave.value,
        tipo: campoPixTipo.value,
      },
    });
  }

  function limparErro(campo, erro) {
    campo.removeAttribute('aria-invalid');
    erro.hidden = true;
    erro.textContent = '';
  }

  function atualizarPreviaPix() {
    const pix = lerPixFormulario();
    const dica = dicasChave[pix.tipo] || dicasChave.aleatoria;
    campoPixChave.placeholder = dica.placeholder;
    campoPixChave.inputMode = dica.inputMode;
    tela.querySelector('#ajuda-pix-chave').textContent = dica.texto;
    tela.querySelector('#previa-pix-favorecido').textContent = pix.nomeFavorecido || 'Nome do favorecido não informado';
    tela.querySelector('#previa-pix-chave').textContent = pix.chave
      ? `${TIPOS_CHAVE_PIX[pix.tipo]} · ${pix.chave}`
      : 'Chave PIX não informada';
  }

  function atualizarRotulos() {
    const min = Number(sliderMin.value);
    const max = Math.max(Number(sliderMax.value), min);
    sliderMax.value = max;
    tela.querySelector('#rotulo-min').textContent = `${min}s`;
    tela.querySelector('#rotulo-max').textContent = `${max}s`;
  }

  sliderMin.addEventListener('input', atualizarRotulos);
  sliderMax.addEventListener('input', atualizarRotulos);
  campoPixFavorecido.addEventListener('input', () => {
    limparErro(campoPixFavorecido, tela.querySelector('#erro-pix-favorecido'));
    atualizarPreviaPix();
  });
  campoPixChave.addEventListener('input', () => {
    limparErro(campoPixChave, tela.querySelector('#erro-pix-chave'));
    atualizarPreviaPix();
  });
  campoPixTipo.addEventListener('change', () => {
    limparErro(campoPixChave, tela.querySelector('#erro-pix-chave'));
    atualizarPreviaPix();
  });
  atualizarRotulos();
  atualizarPreviaPix();

  botaoSalvar.addEventListener('click', async () => {
    const validacaoPix = validarConfigPix({ pix: lerPixFormulario() });
    const erroFavorecido = tela.querySelector('#erro-pix-favorecido');
    const erroChave = tela.querySelector('#erro-pix-chave');
    limparErro(campoPixFavorecido, erroFavorecido);
    limparErro(campoPixChave, erroChave);
    if (!validacaoPix.valido) {
      if (validacaoPix.erros.nomeFavorecido) {
        campoPixFavorecido.setAttribute('aria-invalid', 'true');
        erroFavorecido.textContent = validacaoPix.erros.nomeFavorecido;
        erroFavorecido.hidden = false;
      }
      if (validacaoPix.erros.chave) {
        campoPixChave.setAttribute('aria-invalid', 'true');
        erroChave.textContent = validacaoPix.erros.chave;
        erroChave.hidden = false;
      }
      (validacaoPix.erros.nomeFavorecido ? campoPixFavorecido : campoPixChave).focus();
      mostrarToast(validacaoPix.mensagem, 'erro');
      return;
    }

    const aliasesPix = configPixComAliases(validacaoPix.pix);
    const payload = {
      ...aliasesPix,
      intervaloMin: Number(sliderMin.value),
      intervaloMax: Number(sliderMax.value),
    };
    const textoOriginal = botaoSalvar.textContent;
    botaoSalvar.disabled = true;
    botaoSalvar.textContent = 'Salvando...';
    try {
      const salvas = await api.saveSettings(payload);
      const configMesclada = { ...estado.config, ...payload, ...(salvas || {}) };
      estado.config = { ...configMesclada, ...configPixComAliases(configMesclada) };
      mostrarToast('Dados PIX e preferências salvos.', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível salvar as configurações.', 'erro');
    } finally {
      if (botaoSalvar.isConnected) {
        botaoSalvar.disabled = false;
        botaoSalvar.textContent = textoOriginal;
      }
    }
  });

  const listaTemplates = tela.querySelector('#lista-templates');
  async function atualizarTemplates() {
    estado.config.templates = await api.listTemplates();
    renderizarTemplates();
  }
  function renderizarTemplates() {
    if (!estado.config.templates.length) {
      listaTemplates.innerHTML = '<div class="estado-vazio" style="padding:24px 10px"><p>Nenhum template salvo.</p></div>';
      return;
    }
    listaTemplates.innerHTML = estado.config.templates.map((template) => `
      <div class="linha-template"><span>${escaparHtml(template.nome)}</span><span style="display:flex;gap:4px"><button class="btn btn--fantasma" type="button" data-editar="${escaparHtml(template.id)}" aria-label="Editar template ${escaparHtml(template.nome)}" title="Editar">${Icone.editar}</button><button class="btn btn--fantasma" type="button" data-excluir="${escaparHtml(template.id)}" aria-label="Excluir template ${escaparHtml(template.nome)}" title="Excluir">${Icone.lixeira}</button></span></div>`).join('');
  }
  renderizarTemplates();
  tela.querySelector('#btn-novo-template').addEventListener('click', () => abrirEditorTemplate(atualizarTemplates));
  tela.querySelector('#btn-importar-template').addEventListener('click', async () => {
    try {
      const resultado = await api.importTemplate();
      if (resultado.cancelado) return;
      await atualizarTemplates();
      mostrarToast('Template importado', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel importar o template.', 'erro');
    }
  });
  listaTemplates.addEventListener('click', async (event) => {
    const editar = event.target.closest('[data-editar]');
    const excluir = event.target.closest('[data-excluir]');
    if (editar) {
      const template = estado.config.templates.find((item) => String(item.id) === String(editar.dataset.editar));
      abrirEditorTemplate(atualizarTemplates, template);
    }
    if (excluir) {
      const template = estado.config.templates.find((item) => String(item.id) === String(excluir.dataset.excluir));
      if (!confirm(`Excluir o template "${template?.nome || 'selecionado'}"? Esta ação não pode ser desfeita.`)) return;
      try {
        excluir.disabled = true;
        await api.deleteTemplate(excluir.dataset.excluir);
        await atualizarTemplates();
        mostrarToast('Template excluido', 'aviso');
      } catch (error) {
        mostrarToast(error.message || 'Nao foi possivel excluir o template.', 'erro');
      } finally {
        if (excluir.isConnected) excluir.disabled = false;
      }
    }
  });
}

function abrirEditorTemplate(aoSalvar, templateExistente) {
  const { elemento, fechar } = abrirModal({
    titulo: templateExistente ? 'Editar template' : 'Novo template',
    corpoHtml: `<div class="campo"><label for="nome-tpl">Nome</label><input type="text" id="nome-tpl" value="${escaparHtml(templateExistente?.nome)}"></div><div class="campo"><label for="texto-tpl">Mensagem</label><textarea id="texto-tpl" rows="9" aria-describedby="ajuda-placeholders-tpl">${escaparHtml(templateExistente?.texto)}</textarea><small id="ajuda-placeholders-tpl">Dados PIX disponíveis: {{pix_nome_favorecido}}, {{pix_chave}} e {{pix_tipo}}. Somente os placeholders são substituídos; nenhum aviso ou rodapé é acrescentado.</small></div>`,
    rodapeHtml: '<button class="btn btn--secundario" data-cancelar>Cancelar</button><button class="btn btn--primario" data-salvar>Salvar</button>',
  });
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);
  elemento.querySelector('[data-salvar]').addEventListener('click', async () => {
    const nome = elemento.querySelector('#nome-tpl').value.trim();
    const texto = elemento.querySelector('#texto-tpl').value.trim();
    if (!nome || !texto) return mostrarToast('Preencha nome e mensagem.', 'erro');
    try {
      await api.saveTemplate({ id: templateExistente?.id, nome, texto });
      await aoSalvar();
      fechar();
      mostrarToast('Template salvo', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel salvar o template.', 'erro');
    }
  });
}
