import { estado, formatarMoeda, formatarTelefone } from '../nucleo/estado.js';
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

export function montarClientes(alvo) {
  let filtroStatus = 'todos';
  let termoBusca = '';
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Clientes</h1><p class="legenda" id="legenda-clientes"></p></div>
        <button class="btn btn--primario" id="btn-importar" type="button">${Icone.upload} Importar tabela</button>
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
  const { elemento, fechar } = abrirModal({
    titulo: 'Importar tabela de clientes',
    corpoHtml: `
      <div class="zona-drop" style="cursor:default" id="instrucao-importacao">
        ${Icone.upload}
        <p style="font-weight:600">Selecione uma tabela para atualizar a base</p>
        <p style="font-size:12.5px;color:var(--vv-texto-sutil);margin-top:4px">Formatos aceitos: XLS, XLSX, CSV e PDF textual. Clientes existentes são atualizados por CPF, telefone ou nome normalizado.</p>
      </div>
      <div id="resultado-importacao" role="status" aria-live="polite" aria-atomic="true" style="margin-top:16px"></div>`,
    rodapeHtml: '<button class="btn btn--secundario" type="button" data-cancelar>Cancelar</button><button class="btn btn--primario" type="button" data-selecionar>Selecionar arquivo</button>',
  });
  const botaoSelecionar = elemento.querySelector('[data-selecionar]');
  const areaResultado = elemento.querySelector('#resultado-importacao');
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);

  botaoSelecionar.addEventListener('click', async () => {
    botaoSelecionar.disabled = true;
    botaoSelecionar.setAttribute('aria-busy', 'true');
    botaoSelecionar.textContent = 'Importando...';
    try {
      const resultado = await api.importCustomers();
      if (resultado?.cancelado) {
        botaoSelecionar.textContent = 'Selecionar arquivo';
        return;
      }
      estado.clientes = await api.listCustomers();
      areaResultado.innerHTML = `
        <div class="badge badge--sucesso">${numeroSeguro(resultado.created)} novos</div>
        <div class="badge badge--neutro" style="margin-left:8px">${numeroSeguro(resultado.updated)} atualizados</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil);margin-top:12px">${escaparHtml(resultado.arquivo || 'Arquivo importado')} (${escaparHtml(resultado.formato || 'formato identificado')}): ${numeroSeguro(resultado.totalLido)} linhas lidas, ${numeroSeguro(resultado.invalidos)} ignoradas.</p>`;
      aoConcluir();
      mostrarToast('Base de clientes atualizada', 'sucesso');
      botaoSelecionar.textContent = 'Importar outro arquivo';
    } catch (error) {
      areaResultado.innerHTML = `<p style="color:var(--vv-erro);font-size:13px">${escaparHtml(error.message || error)}</p>`;
      mostrarToast(error.message || 'Nao foi possivel importar o arquivo.', 'erro');
      botaoSelecionar.textContent = 'Tentar novamente';
    } finally {
      botaoSelecionar.disabled = false;
      botaoSelecionar.removeAttribute('aria-busy');
    }
  });
}
