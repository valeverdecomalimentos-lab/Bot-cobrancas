import { estado, aplicarBootstrap, formatarMoeda, formatarTelefone } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const ROTULO_STATUS = {
  em_dia: ['Em dia', 'sucesso'],
  devedor: ['Devedor', 'alerta'],
  sem_telefone: ['Sem telefone', 'neutro'],
};

const ROTULO_PERFIL = {
  critico: ['Cobrança prioritária', 'erro'],
  atencao: ['Cobrança elegível', 'alerta'],
  acompanhamento: ['Acompanhar saldo', 'neutro'],
  contato: ['Atualizar contato', 'alerta'],
  regular: ['Cliente regular', 'sucesso'],
};

function valorDevido(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

function numeroSeguro(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

const ETAPAS_BACKUP = {
  baixando: 'Baixando o backup do Google Drive…',
  download: 'Baixando o backup do Google Drive…',
  downloading: 'Baixando o backup do Google Drive…',
  validando: 'Validando o arquivo de backup…',
  validacao: 'Validando o arquivo de backup…',
  validating: 'Validando o arquivo de backup…',
  restaurando: 'Restaurando uma cópia temporária…',
  restauracao: 'Restaurando uma cópia temporária…',
  restoring: 'Restaurando uma cópia temporária…',
  extraindo: 'Lendo clientes, pedidos e pagamentos…',
  extracao: 'Lendo clientes, pedidos e pagamentos…',
  extracting: 'Lendo clientes, pedidos e pagamentos…',
  gravando: 'Atualizando a base analítica local…',
  persistencia: 'Atualizando a base analítica local…',
  persisting: 'Atualizando a base analítica local…',
  'calculando-perfis': 'Calculando os perfis dos clientes…',
  limpando: 'Removendo os arquivos temporários…',
  concluido: 'Importação concluída.',
  completed: 'Importação concluída.',
};

export function validarLinkBackupGoogleDrive(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return { valido: false, erro: 'Cole o link compartilhado do arquivo de backup.' };
  if (texto.length > 2048) return { valido: false, erro: 'O link informado é muito longo.' };

  let url;
  try {
    url = new URL(texto);
  } catch {
    return { valido: false, erro: 'Informe um link válido do Google Drive.' };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(host)) {
    return { valido: false, erro: 'Use um link HTTPS compartilhado pelo Google Drive.' };
  }
  if (/\/folders\//i.test(url.pathname)) {
    return { valido: false, erro: 'Esse é o link de uma pasta. Abra o backup e copie o link do arquivo .fbconsumer.' };
  }

  const idNoCaminho = url.pathname.match(/\/file\/d\/([^/]+)/i)?.[1];
  const idNaConsulta = url.searchParams.get('id');
  if (!idNoCaminho && !idNaConsulta) {
    return { valido: false, erro: 'Não foi possível identificar o arquivo nesse link do Google Drive.' };
  }
  return { valido: true, url: url.toString(), erro: '' };
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

function mensagemDeErro(error, fallback) {
  return String(error?.message || error || fallback)
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}

export function montarClientes(alvo) {
  let filtroStatus = 'todos';
  let termoBusca = '';
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Clientes</h1><p class="legenda" id="legenda-clientes"></p></div>
        <button class="btn btn--primario" id="btn-importar" type="button">${Icone.upload} Importar dados</button>
      </div>
      <div class="barra-ferramentas">
        <div class="grupo-filtros" id="grupo-filtros" role="group" aria-label="Filtrar clientes por status">
          <button class="chip-filtro ativo" type="button" data-status="todos" aria-pressed="true">Todos</button>
          <button class="chip-filtro" type="button" data-status="devedor" aria-pressed="false">Devedores</button>
          <button class="chip-filtro" type="button" data-status="em_dia" aria-pressed="false">Em dia</button>
          <button class="chip-filtro" type="button" data-status="sem_telefone" aria-pressed="false">Sem telefone</button>
        </div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por nome, CPF ou telefone" id="campo-busca" aria-label="Buscar clientes por nome, CPF ou telefone" autocomplete="off"></div>
      </div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes" aria-label="Lista de clientes">
          <thead><tr><th scope="col">Nome</th><th scope="col">Telefone</th><th scope="col">Valor devido</th><th scope="col">Status</th><th scope="col">Perfil</th></tr></thead>
          <tbody id="corpo-tabela"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const corpoTabela = tela.querySelector('#corpo-tabela');
  const legenda = tela.querySelector('#legenda-clientes');

  function renderizarLinhas() {
    const busca = termoBusca.trim().toLowerCase();
    const clientes = (Array.isArray(estado.clientes) ? estado.clientes : [])
      .filter((cliente) => cliente && typeof cliente === 'object');
    const filtrados = clientes.filter((cliente) => {
      const passaStatus = filtroStatus === 'todos' || cliente.status === filtroStatus;
      const texto = [cliente.nome, cliente.cpf, cliente.telefone].join(' ').toLowerCase();
      return passaStatus && (!busca || texto.includes(busca));
    });
    legenda.textContent = `${clientes.length} clientes persistidos na base local`;
    if (!filtrados.length) {
      const mensagem = clientes.length
        ? 'Nenhum cliente corresponde aos filtros selecionados.'
        : 'Nenhum cliente foi importado ainda.';
      corpoTabela.innerHTML = `<tr><td colspan="5"><div class="estado-vazio" role="status">${Icone.clientes}<p>${mensagem}</p></div></td></tr>`;
      return;
    }
    corpoTabela.innerHTML = filtrados.map((cliente) => {
      const [rotulo, tom] = ROTULO_STATUS[cliente.status] || ['Sem status', 'neutro'];
      const perfil = cliente.perfilAnalitico || null;
      const [rotuloPerfil, tomPerfil] = perfil ? (ROTULO_PERFIL[perfil.nivel] || [perfil.rotulo, 'neutro']) : ['Perfil indisponível', 'neutro'];
      return `<tr>
        <td class="celula-nome">${escaparHtml(cliente.nome || 'Sem nome')}</td>
        <td>${escaparHtml(formatarTelefone(cliente.telefone))}</td>
        <td class="celula-valor">${formatarMoeda(valorDevido(cliente))}</td>
        <td><span class="badge badge--${tom}">${rotulo}</span></td>
        <td><span class="badge badge--${tomPerfil}" title="${escaparHtml(perfil?.motivo || '')}">${escaparHtml(rotuloPerfil)}</span></td>
      </tr>`;
    }).join('');
  }

  renderizarLinhas();
  tela.querySelector('#grupo-filtros').addEventListener('click', (event) => {
    const botao = event.target instanceof Element ? event.target.closest('.chip-filtro') : null;
    if (!botao) return;
    tela.querySelectorAll('.chip-filtro').forEach((item) => {
      item.classList.remove('ativo');
      item.setAttribute('aria-pressed', 'false');
    });
    botao.classList.add('ativo');
    botao.setAttribute('aria-pressed', 'true');
    filtroStatus = botao.dataset.status;
    renderizarLinhas();
  });
  tela.querySelector('#campo-busca').addEventListener('input', (event) => {
    termoBusca = event.target.value;
    renderizarLinhas();
  });
  tela.querySelector('#btn-importar').addEventListener('click', () => abrirModalImportacao(renderizarLinhas));
}

function abrirModalImportacao(aoConcluir) {
  let cancelarProgresso = () => {};
  const { elemento, fechar } = abrirModal({
    titulo: 'Importar dados de clientes',
    corpoHtml: `
      <div class="importacao-fontes" id="fontes-importacao">
        <section class="importacao-fonte importacao-fonte--destaque" aria-labelledby="titulo-fonte-backup">
          <div class="importacao-fonte__cabecalho">
            <span class="importacao-fonte__icone" aria-hidden="true">${Icone.atualizar}</span>
            <div>
              <span class="badge badge--sucesso">Histórico completo</span>
              <h4 id="titulo-fonte-backup">Backup do Consumer</h4>
              <p>Importa clientes, compras, itens, pagamentos e entregas disponíveis no arquivo <strong>.fbconsumer</strong>.</p>
            </div>
          </div>
          <button class="btn btn--primario importacao-fonte__acao" type="button" data-backup-local>${Icone.upload} Selecionar backup .fbconsumer</button>
          <div class="importacao-separador" aria-hidden="true"><span>ou</span></div>
          <form id="form-backup-drive" novalidate>
            <label for="campo-link-backup">Link do arquivo no Google Drive</label>
            <div class="importacao-link-linha">
              <input id="campo-link-backup" name="backupUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://drive.google.com/file/d/…/view" aria-describedby="ajuda-link-backup erro-link-backup">
              <button class="btn btn--secundario" type="submit" data-backup-link>Importar link</button>
            </div>
            <p class="ajuda-campo" id="ajuda-link-backup">Cole o link compartilhado do arquivo, não o link da pasta. O acesso precisa permitir a leitura do backup.</p>
            <p class="erro-campo" id="erro-link-backup" role="alert" hidden></p>
          </form>
        </section>

        <section class="importacao-fonte" aria-labelledby="titulo-fonte-tabela">
          <div class="importacao-fonte__cabecalho">
            <span class="importacao-fonte__icone" aria-hidden="true">${Icone.clientes}</span>
            <div>
              <span class="badge badge--neutro">Cadastro e saldos</span>
              <h4 id="titulo-fonte-tabela">Tabela de clientes</h4>
              <p>Continua aceitando XLS, XLSX, CSV e PDF textual para atualizar a lista atual.</p>
            </div>
          </div>
          <button class="btn btn--secundario importacao-fonte__acao" type="button" data-tabela>${Icone.upload} Selecionar tabela</button>
        </section>
      </div>
      <div class="importacao-andamento" id="andamento-importacao" aria-live="polite" aria-atomic="true" hidden>
        <div class="importacao-andamento__texto"><strong id="texto-andamento">Preparando importação…</strong><span id="percentual-andamento"></span></div>
        <div class="importacao-barra" id="barra-importacao" role="progressbar" aria-label="Progresso da importação"><i></i></div>
        <p>Não feche o aplicativo enquanto os dados estão sendo processados.</p>
      </div>
      <div id="resultado-importacao" class="resultado-importacao" role="status" aria-live="polite" aria-atomic="true"></div>`,
    rodapeHtml: '<button class="btn btn--secundario" type="button" data-fechar-importacao>Fechar</button>',
    aoFechar: () => cancelarProgresso(),
  });
  const fontes = elemento.querySelector('#fontes-importacao');
  const botaoBackupLocal = elemento.querySelector('[data-backup-local]');
  const botaoBackupLink = elemento.querySelector('[data-backup-link]');
  const botaoTabela = elemento.querySelector('[data-tabela]');
  const formularioLink = elemento.querySelector('#form-backup-drive');
  const campoLink = elemento.querySelector('#campo-link-backup');
  const erroLink = elemento.querySelector('#erro-link-backup');
  const areaAndamento = elemento.querySelector('#andamento-importacao');
  const textoAndamento = elemento.querySelector('#texto-andamento');
  const percentualAndamento = elemento.querySelector('#percentual-andamento');
  const barraAndamento = elemento.querySelector('#barra-importacao');
  const areaResultado = elemento.querySelector('#resultado-importacao');
  const controles = [botaoBackupLocal, botaoBackupLink, botaoTabela, campoLink];
  let ocupado = false;
  let tipoEmAndamento = '';
  let botaoEmAndamento = null;
  let conteudoOriginalBotao = '';

  elemento.querySelector('[data-fechar-importacao]').addEventListener('click', fechar);

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

  function atualizarProgresso(progresso = {}) {
    if (!ocupado || tipoEmAndamento !== 'backup') return;
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
      botao.textContent = tipo === 'backup' ? 'Importando backup…' : 'Importando tabela…';
    } else if (botaoEmAndamento) {
      botaoEmAndamento.innerHTML = conteudoOriginalBotao;
      botaoEmAndamento.removeAttribute('aria-busy');
      botaoEmAndamento = null;
      conteudoOriginalBotao = '';
    }
  }

  async function atualizarDadosDaTela() {
    try {
      const dados = await api.bootstrap();
      if (dados && typeof dados === 'object') {
        aplicarBootstrap(dados);
        aoConcluir();
        return;
      }
    } catch {
      // O fallback abaixo ainda atualiza a lista quando o bootstrap não estiver disponível.
    }
    try {
      estado.clientes = await api.listCustomers();
    } catch {
      // A importação já foi concluída; uma futura navegação recarregará o estado persistido.
    }
    aoConcluir();
  }

  function renderizarResultadoTabela(resultado) {
    const arquivo = nomeArquivoSeguro(resultado.arquivo) || 'Tabela importada';
    areaResultado.innerHTML = `
      <div class="resultado-importacao__cartao resultado-importacao__cartao--sucesso">
        <div class="resultado-importacao__titulo">${Icone.check}<div><strong>Base de clientes atualizada</strong><p>${escaparHtml(arquivo)} (${escaparHtml(resultado.formato || 'formato identificado')})</p></div></div>
        <div class="resultado-importacao__metricas">
          <div><strong>${numeroSeguro(resultado.created)}</strong><span>novos</span></div>
          <div><strong>${numeroSeguro(resultado.updated)}</strong><span>atualizados</span></div>
          <div><strong>${numeroSeguro(resultado.totalLido)}</strong><span>linhas lidas</span></div>
          <div><strong>${numeroSeguro(resultado.invalidos)}</strong><span>ignoradas</span></div>
        </div>
      </div>`;
  }

  function renderizarResultadoBackup(resultado) {
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
    const arquivo = nomeArquivoSeguro(resultado.arquivo || resultado.nomeArquivo) || 'Backup do Consumer';
    const avisos = Array.isArray(resultado.avisos)
      ? resultado.avisos.filter(Boolean)
      : (resultado.aviso ? [resultado.aviso] : []);

    const duplicada = String(resultado.status || '').toLowerCase() === 'duplicada';
    areaResultado.innerHTML = `
      <div class="resultado-importacao__cartao resultado-importacao__cartao--sucesso">
        <div class="resultado-importacao__titulo">${Icone.check}<div><strong>${duplicada ? 'Backup já estava importado' : 'Backup importado com sucesso'}</strong><p>${escaparHtml(arquivo)}${duplicada ? ' — nenhuma informação foi duplicada.' : ''}</p></div></div>
        ${metricas.length ? `<div class="resultado-importacao__metricas">${metricas.map(([rotulo, quantidade]) => `<div><strong>${quantidade.toLocaleString('pt-BR')}</strong><span>${escaparHtml(rotulo)}</span></div>`).join('')}</div>` : '<p class="resultado-importacao__mensagem">Os dados disponíveis no backup foram incorporados à base local.</p>'}
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
    if (tipo === 'backup') atualizarProgresso({ mensagem: 'Preparando o backup para importação…' });
    else areaAndamento.hidden = true;
    try {
      const resultado = await chamar();
      if (resultado?.cancelado) {
        areaAndamento.hidden = true;
        return;
      }
      if (tipo === 'backup') atualizarProgresso({ etapa: 'concluido', percentual: 100 });
      await atualizarDadosDaTela();
      if (tipo === 'backup') renderizarResultadoBackup(resultado || {});
      else renderizarResultadoTabela(resultado || {});
      const backupDuplicado = tipo === 'backup' && String(resultado?.status || '').toLowerCase() === 'duplicada';
      mostrarToast(
        backupDuplicado
          ? 'Esse backup já estava na base'
          : (tipo === 'backup' ? 'Histórico do Consumer importado' : 'Base de clientes atualizada'),
        'sucesso',
      );
    } catch (error) {
      areaAndamento.hidden = true;
      const mensagem = mensagemDeErro(error, 'Não foi possível importar o arquivo.');
      renderizarFalha(mensagem);
      mostrarToast(mensagem, 'erro');
    } finally {
      definirOcupado(false);
    }
  }

  cancelarProgresso = api.onConsumerBackupProgress(atualizarProgresso);

  botaoBackupLocal.addEventListener('click', () => executarImportacao({
    tipo: 'backup',
    botao: botaoBackupLocal,
    chamar: () => api.importConsumerBackup(),
  }));

  formularioLink.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const validacao = validarLinkBackupGoogleDrive(campoLink.value);
    if (!validacao.valido) {
      mostrarErroLink(validacao.erro);
      return;
    }
    executarImportacao({
      tipo: 'backup',
      botao: botaoBackupLink,
      chamar: () => api.importConsumerBackupFromUrl(validacao.url),
    });
  });

  campoLink.addEventListener('input', limparErroLink);
  botaoTabela.addEventListener('click', () => executarImportacao({
    tipo: 'tabela',
    botao: botaoTabela,
    chamar: () => api.importCustomers(),
  }));
}
