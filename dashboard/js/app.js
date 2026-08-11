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
import { escaparHtml } from './nucleo/ui.js';

const ITENS_MENU = [
  { rota: 'dashboard', rotulo: 'Painel', icone: Icone.painel },
  { rota: 'clientes', rotulo: 'Clientes', icone: Icone.clientes },
  { rota: 'produtos', rotulo: 'Produtos', icone: Icone.produtos },
  { rota: 'nova-campanha', rotulo: 'Nova campanha', icone: Icone.campanha },
  { rota: 'historico', rotulo: 'Histórico', icone: Icone.historico },
  { rota: 'configuracoes', rotulo: 'Configurações', icone: Icone.config },
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

let controladorShell = null;
let desmontarLoginAtual = null;

function metadadosRota(nomeRota) {
  if (nomeRota === 'envio') return { rotulo: 'Envio em andamento', titulo: 'Envio' };
  const item = ITENS_MENU.find(({ rota }) => rota === nomeRota) || ITENS_MENU[0];
  return { rotulo: item.rotulo, titulo: item.rotulo };
}

function textoConexao() {
  const conectado = estado.conexaoWhatsapp.status === 'conectado';
  return {
    conectado,
    rotulo: conectado ? 'WhatsApp conectado' : 'WhatsApp desconectado',
    detalhe: conectado
      ? (estado.conexaoWhatsapp.numero || 'Sessão ativa')
      : 'Abra Conexão para vincular',
  };
}

function atualizarIndicadoresConexao() {
  const conexao = textoConexao();
  document.querySelectorAll('[data-indicador-conexao]').forEach((ponto) => {
    ponto.classList.toggle('on', conexao.conectado);
  });

  const rotulo = document.querySelector('[data-rotulo-conexao]');
  const detalhe = document.querySelector('[data-detalhe-conexao]');
  const statusCurto = document.querySelector('[data-status-curto]');
  const atalho = document.querySelector('#btn-conexao-topo');
  const statusHero = document.querySelector('.hero-dashboard__status');
  if (rotulo) rotulo.textContent = conexao.rotulo;
  if (detalhe) detalhe.textContent = conexao.detalhe;
  if (statusCurto) statusCurto.textContent = conexao.conectado ? 'Online' : 'Offline';
  if (atalho) atalho.setAttribute('aria-label', `${conexao.rotulo}. Abrir conexão.`);
  if (statusHero) {
    statusHero.querySelector('.status-pulso')?.classList.toggle('on', conexao.conectado);
    const tituloHero = statusHero.querySelector('strong');
    const detalheHero = statusHero.querySelector('small');
    if (tituloHero) tituloHero.textContent = conexao.conectado ? 'WhatsApp disponível' : 'WhatsApp desconectado';
    if (detalheHero) detalheHero.textContent = conexao.conectado ? 'Pronto para testes e envios' : 'Conecte antes de iniciar campanhas';
  }
}

function montarShell(nomeRota) {
  controladorShell?.abort();
  controladorShell = new AbortController();
  const { signal } = controladorShell;
  document.body.classList.remove('menu-aberto');

  const raiz = document.getElementById('raiz');
  const conexao = textoConexao();
  const rota = metadadosRota(nomeRota);
  raiz.innerHTML = `
    <button class="link-pular" id="link-pular" type="button">Pular para o conteúdo</button>
    <aside class="barra-lateral" id="barra-lateral" aria-label="Navegação principal">
      <div class="barra-lateral__cabecalho">
        <div class="marca">
          <img src="../logoi.png" alt="">
          <div><strong>Vale Verde</strong><span>Central de operações</span></div>
        </div>
        <button class="btn-fechar-menu" id="btn-fechar-menu" type="button" aria-label="Fechar menu">${Icone.fechar}</button>
      </div>
      <span class="nav-legenda">Navegação</span>
      <nav id="nav-menu" aria-label="Seções do painel"></nav>
      <div class="sidebar-spacer" aria-hidden="true"></div>
      <div class="barra-lateral__rodape">
        <button class="nav-item" id="btn-conexao" type="button">${Icone.config} Conexão</button>
        <div class="status-conexao-mini" id="status-mini" aria-live="polite">
          <div class="linha"><span class="ponto ${conexao.conectado ? 'on' : ''}" data-indicador-conexao></span><span data-rotulo-conexao>${conexao.rotulo}</span></div>
          <small data-detalhe-conexao>${escaparHtml(conexao.detalhe)}</small>
        </div>
      </div>
    </aside>
    <button class="menu-sobreposicao" id="menu-sobreposicao" type="button" aria-label="Fechar menu" tabindex="-1" hidden></button>
    <section class="area-principal">
      <header class="topbar-shell">
        <div class="topbar-inicio">
          <button class="botao-menu-mobile" id="btn-abrir-menu" type="button" aria-label="Abrir menu" aria-controls="barra-lateral" aria-expanded="false">${Icone.menu}</button>
          <div class="topbar-contexto">
            <span class="topbar-eyebrow">Central de operações</span>
            <strong class="topbar-rota">${rota.rotulo}</strong>
          </div>
        </div>
        <div class="topbar-acoes">
          <button class="topbar-conexao" id="btn-conexao-topo" type="button" aria-label="${conexao.rotulo}. Abrir conexão.">
            <span class="ponto ${conexao.conectado ? 'on' : ''}" data-indicador-conexao></span>
            <span data-status-curto>${conexao.conectado ? 'Online' : 'Offline'}</span>
          </button>
        </div>
      </header>
      <main class="conteudo" id="conteudo" tabindex="-1"></main>
    </section>`;

  const navMenu = raiz.querySelector('#nav-menu');
  navMenu.innerHTML = ITENS_MENU.map((item) =>
    `<button class="nav-item ${item.rota === nomeRota ? 'ativo' : ''}" type="button" data-rota="${item.rota}" ${item.rota === nomeRota ? 'aria-current="page"' : ''}>${item.icone}<span>${item.rotulo}</span></button>`
  ).join('');

  const barraLateral = raiz.querySelector('#barra-lateral');
  const abrirMenu = raiz.querySelector('#btn-abrir-menu');
  const fecharMenu = raiz.querySelector('#btn-fechar-menu');
  const sobreposicao = raiz.querySelector('#menu-sobreposicao');
  const areaPrincipal = raiz.querySelector('.area-principal');
  const conteudo = raiz.querySelector('#conteudo');
  const consultaMenuCompacto = window.matchMedia('(max-width: 960px)');
  let focoAnterior = null;

  const menuEstaAberto = () => barraLateral.classList.contains('aberta');
  const definirMenuAberto = (aberto, devolverFoco = true) => {
    const modoCompacto = consultaMenuCompacto.matches;
    const deveAbrir = Boolean(aberto && modoCompacto);
    barraLateral.classList.toggle('aberta', deveAbrir);
    barraLateral.inert = modoCompacto && !deveAbrir;
    barraLateral.setAttribute('aria-hidden', String(modoCompacto && !deveAbrir));
    document.body.classList.toggle('menu-aberto', deveAbrir);
    abrirMenu.setAttribute('aria-expanded', String(deveAbrir));
    sobreposicao.hidden = !deveAbrir;
    areaPrincipal.inert = deveAbrir;

    if (deveAbrir) {
      focoAnterior = document.activeElement;
      requestAnimationFrame(() => fecharMenu.focus());
    } else if (devolverFoco && focoAnterior?.isConnected) {
      focoAnterior.focus();
      focoAnterior = null;
    }
  };

  abrirMenu.addEventListener('click', () => definirMenuAberto(true), { signal });
  fecharMenu.addEventListener('click', () => definirMenuAberto(false), { signal });
  sobreposicao.addEventListener('click', () => definirMenuAberto(false), { signal });
  raiz.querySelector('#link-pular').addEventListener('click', () => conteudo.focus(), { signal });

  navMenu.addEventListener('click', (event) => {
    const botao = event.target.closest('[data-rota]');
    if (!botao) return;
    if (botao.dataset.rota === nomeRota) {
      definirMenuAberto(false);
      return;
    }
    definirMenuAberto(false, false);
    navegar(botao.dataset.rota);
  }, { signal });

  const abrirConexao = () => {
    definirMenuAberto(false, false);
    navegar('login');
  };
  raiz.querySelector('#btn-conexao').addEventListener('click', abrirConexao, { signal });
  raiz.querySelector('#btn-conexao-topo').addEventListener('click', abrirConexao, { signal });

  document.addEventListener('keydown', (event) => {
    if (!menuEstaAberto()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      definirMenuAberto(false);
      return;
    }
    if (event.key !== 'Tab') return;

    const focaveis = [...barraLateral.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((elemento) => elemento.getClientRects().length > 0);
    if (!focaveis.length) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (event.shiftKey && document.activeElement === primeiro) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primeiro.focus();
    }
  }, { signal });

  const sincronizarModoMenu = () => {
    if (!consultaMenuCompacto.matches && menuEstaAberto()) {
      definirMenuAberto(false, false);
      navMenu.querySelector('[aria-current="page"]')?.focus();
    }
    if (!menuEstaAberto()) {
      barraLateral.inert = consultaMenuCompacto.matches;
      barraLateral.setAttribute('aria-hidden', String(consultaMenuCompacto.matches));
    }
  };

  window.addEventListener('resize', sincronizarModoMenu, { signal });
  consultaMenuCompacto.addEventListener('change', sincronizarModoMenu, { signal });

  definirMenuAberto(false, false);

  return conteudo;
}

function resolverRota(nomeRota) {
  desmontarLoginAtual?.();
  desmontarLoginAtual = null;
  if (nomeRota === 'login') {
    controladorShell?.abort();
    controladorShell = null;
    document.body.classList.remove('menu-aberto');
    document.title = 'Conexão | Vale Verde';
    const raiz = document.getElementById('raiz');
    raiz.innerHTML = '';
    desmontarLoginAtual = montarLogin(raiz);
    return;
  }
  const conteudo = montarShell(nomeRota);
  const montarTela = MAPA_TELAS[nomeRota] || montarDashboard;
  montarTela(conteudo);
  const rota = metadadosRota(nomeRota);
  document.title = `${rota.titulo} | Vale Verde`;

  requestAnimationFrame(() => {
    const titulo = conteudo.querySelector('h1');
    if (titulo) {
      titulo.setAttribute('tabindex', '-1');
      titulo.focus({ preventScroll: true });
    }
  });
}

function mostrarErroInicial(error) {
  const raiz = document.getElementById('raiz');
  raiz.innerHTML = '<main class="estado-vazio" role="alert"><h1>Não foi possível iniciar o painel</h1><p></p></main>';
  raiz.querySelector('p').textContent = String(error?.message || error);
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
    if (nomeRotaAtual() !== 'login') atualizarIndicadoresConexao();
  });
  iniciarRoteador(resolverRota);
});
