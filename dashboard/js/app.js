import { estado, aplicarBootstrap, atualizarConexaoWhatsapp, barramento } from './nucleo/estado.js';
import { api } from './nucleo/pontos-integracao.js';
import { iniciarRoteador, navegar, nomeRotaAtual } from './nucleo/roteador.js';
import { Icone } from './nucleo/icones.js';
import { montarLogin } from './telas/login.js';
import { montarDashboard } from './telas/dashboard.js';
import { montarClientes } from './telas/clientes.js';
import { montarProdutos } from './telas/produtos.js';
import { montarNovaCampanha } from './telas/campanha-wizard.js';
import { montarEnvio } from './telas/envio.js';
import { montarHistorico } from './telas/historico.js';
import { montarConfiguracoes } from './telas/configuracoes.js';

const ITENS_MENU = [
  { rota: 'dashboard', rotulo: 'Painel', icone: Icone.painel },
  { rota: 'clientes', rotulo: 'Clientes', icone: Icone.clientes },
  { rota: 'produtos', rotulo: 'Produtos', icone: Icone.produtos },
  { rota: 'nova-campanha', rotulo: 'Nova campanha', icone: Icone.campanha },
  { rota: 'historico', rotulo: 'Historico', icone: Icone.historico },
  { rota: 'configuracoes', rotulo: 'Configuracoes', icone: Icone.config },
];

const MAPA_TELAS = {
  dashboard: montarDashboard,
  clientes: montarClientes,
  produtos: montarProdutos,
  'nova-campanha': montarNovaCampanha,
  envio: montarEnvio,
  historico: montarHistorico,
  configuracoes: montarConfiguracoes,
};

function montarShell(nomeRota) {
  const raiz = document.getElementById('raiz');
  const conectado = estado.conexaoWhatsapp.status === 'conectado';
  raiz.innerHTML = `
    <aside class="barra-lateral" id="barra-lateral">
      <div class="marca">
        <img src="../logoi.png" alt="Vale Verde">
        <div><strong>Vale Verde</strong><span>Painel de disparos</span></div>
      </div>
      <nav id="nav-menu"></nav>
      <div style="flex:1"></div>
      <button class="nav-item" id="btn-conexao">${Icone.config} Conexao</button>
      <div class="status-conexao-mini" id="status-mini">
        <div class="linha"><span class="ponto ${conectado ? 'on' : ''}"></span>${conectado ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</div>
        <small>${conectado ? (estado.conexaoWhatsapp.numero || 'Sessao ativa') : 'Abra Conexao para vincular'}</small>
      </div>
    </aside>
    <main class="conteudo" id="conteudo"></main>`;

  const navMenu = raiz.querySelector('#nav-menu');
  navMenu.innerHTML = ITENS_MENU.map((item) =>
    `<button class="nav-item ${item.rota === nomeRota ? 'ativo' : ''}" data-rota="${item.rota}">${item.icone}${item.rotulo}</button>`
  ).join('');
  navMenu.addEventListener('click', (event) => {
    const botao = event.target.closest('[data-rota]');
    if (botao) navegar(botao.dataset.rota);
  });
  raiz.querySelector('#btn-conexao').addEventListener('click', () => navegar('login'));
  return raiz.querySelector('#conteudo');
}

function resolverRota(nomeRota) {
  if (nomeRota === 'login') {
    const raiz = document.getElementById('raiz');
    raiz.innerHTML = '';
    montarLogin(raiz);
    return;
  }
  const conteudo = montarShell(nomeRota);
  const montarTela = MAPA_TELAS[nomeRota] || montarDashboard;
  montarTela(conteudo);
}

function mostrarErroInicial(error) {
  document.getElementById('raiz').innerHTML = `<main class="estado-vazio"><h1>Nao foi possivel iniciar o painel</h1><p>${String(error.message || error)}</p></main>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    aplicarBootstrap(await api.bootstrap());
  } catch (error) {
    mostrarErroInicial(error);
    return;
  }

  api.onWhatsappStatus((status) => {
    atualizarConexaoWhatsapp(status);
    barramento.emit('whatsapp:status', status);
    if (nomeRotaAtual() === 'login') resolverRota('login');
  });
  iniciarRoteador(resolverRota);
});
