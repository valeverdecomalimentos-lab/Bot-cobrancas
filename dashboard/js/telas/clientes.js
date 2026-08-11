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
  critico: ['Cobranca prioritaria', 'erro'],
  atencao: ['Cobranca elegivel', 'alerta'],
  acompanhamento: ['Acompanhar saldo', 'neutro'],
  contato: ['Atualizar contato', 'alerta'],
  regular: ['Cliente regular', 'sucesso'],
};

function valorDevido(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

export function montarClientes(alvo) {
  let filtroStatus = 'todos';
  let termoBusca = '';
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Clientes</h1><p class="legenda" id="legenda-clientes"></p></div>
        <button class="btn btn--primario" id="btn-importar">${Icone.upload} Importar tabela</button>
      </div>
      <div class="barra-ferramentas">
        <div class="grupo-filtros" id="grupo-filtros">
          <button class="chip-filtro ativo" data-status="todos">Todos</button>
          <button class="chip-filtro" data-status="devedor">Devedores</button>
          <button class="chip-filtro" data-status="em_dia">Em dia</button>
          <button class="chip-filtro" data-status="sem_telefone">Sem telefone</button>
        </div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por nome, CPF ou telefone" id="campo-busca"></div>
      </div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes">
          <thead><tr><th>Nome</th><th>Telefone</th><th>Valor devido</th><th>Status</th><th>Perfil</th></tr></thead>
          <tbody id="corpo-tabela"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const corpoTabela = tela.querySelector('#corpo-tabela');
  const legenda = tela.querySelector('#legenda-clientes');

  function renderizarLinhas() {
    const busca = termoBusca.trim().toLowerCase();
    const filtrados = estado.clientes.filter((cliente) => {
      const passaStatus = filtroStatus === 'todos' || cliente.status === filtroStatus;
      const texto = [cliente.nome, cliente.cpf, cliente.telefone].join(' ').toLowerCase();
      return passaStatus && (!busca || texto.includes(busca));
    });
    legenda.textContent = `${estado.clientes.length} clientes persistidos na base local`;
    if (!filtrados.length) {
      corpoTabela.innerHTML = `<tr><td colspan="5"><div class="estado-vazio">${Icone.clientes}<p>Nenhum cliente encontrado.</p></div></td></tr>`;
      return;
    }
    corpoTabela.innerHTML = filtrados.map((cliente) => {
      const [rotulo, tom] = ROTULO_STATUS[cliente.status] || ['Sem status', 'neutro'];
      const perfil = cliente.perfilAnalitico || null;
      const [rotuloPerfil, tomPerfil] = perfil ? (ROTULO_PERFIL[perfil.nivel] || [perfil.rotulo, 'neutro']) : ['Perfil indisponivel', 'neutro'];
      return `<tr>
        <td class="celula-nome">${escaparHtml(cliente.nome || 'Sem nome')}</td>
        <td>${formatarTelefone(cliente.telefone)}</td>
        <td class="celula-valor">${formatarMoeda(valorDevido(cliente))}</td>
        <td><span class="badge badge--${tom}">${rotulo}</span></td>
        <td><span class="badge badge--${tomPerfil}" title="${escaparHtml(perfil?.motivo || '')}">${escaparHtml(rotuloPerfil)}</span></td>
      </tr>`;
    }).join('');
  }

  renderizarLinhas();
  tela.querySelector('#grupo-filtros').addEventListener('click', (event) => {
    const botao = event.target.closest('.chip-filtro');
    if (!botao) return;
    tela.querySelectorAll('.chip-filtro').forEach((item) => item.classList.remove('ativo'));
    botao.classList.add('ativo');
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
      <div class="zona-drop" style="cursor:default">
        ${Icone.upload}
        <p style="font-weight:600">Selecione uma tabela para atualizar a base</p>
        <p style="font-size:12.5px;color:var(--vv-texto-sutil);margin-top:4px">Formatos aceitos: XLS, XLSX, CSV e PDF textual. Clientes existentes sao atualizados por CPF, telefone ou nome normalizado.</p>
      </div>
      <div id="resultado-importacao" style="margin-top:16px"></div>`,
    rodapeHtml: '<button class="btn btn--secundario" data-cancelar>Cancelar</button><button class="btn btn--primario" data-selecionar>Selecionar arquivo</button>',
  });
  const botaoSelecionar = elemento.querySelector('[data-selecionar]');
  const areaResultado = elemento.querySelector('#resultado-importacao');
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);

  botaoSelecionar.addEventListener('click', async () => {
    botaoSelecionar.disabled = true;
    botaoSelecionar.textContent = 'Importando...';
    try {
      const resultado = await api.importCustomers();
      if (resultado.cancelado) return;
      estado.clientes = await api.listCustomers();
      areaResultado.innerHTML = `
        <div class="badge badge--sucesso">${resultado.created} novos</div>
        <div class="badge badge--neutro" style="margin-left:8px">${resultado.updated} atualizados</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil);margin-top:12px">${escaparHtml(resultado.arquivo)} (${resultado.formato}): ${resultado.totalLido} linhas lidas, ${resultado.invalidos} ignoradas.</p>`;
      aoConcluir();
      mostrarToast('Base de clientes atualizada', 'sucesso');
      botaoSelecionar.textContent = 'Importar outro arquivo';
    } catch (error) {
      areaResultado.innerHTML = `<p style="color:var(--vv-erro);font-size:13px">${escaparHtml(error.message || error)}</p>`;
      mostrarToast(error.message || 'Nao foi possivel importar o arquivo.', 'erro');
      botaoSelecionar.textContent = 'Tentar novamente';
    } finally {
      botaoSelecionar.disabled = false;
    }
  });
}
