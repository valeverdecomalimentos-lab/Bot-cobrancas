import { estado } from './nucleo/estado.js';
import { iniciarRoteador, navegar } from './nucleo/roteador.js';
import { Icone } from './nucleo/icones.js';
import { montarLogin } from './telas/login.js';
import { montarDashboard } from './telas/dashboard.js';
import { montarClientes } from './telas/clientes.js';
import { montarNovaCampanha } from './telas/campanha-wizard.js';
import { montarEnvio } from './telas/envio.js';
import { montarHistorico } from './telas/historico.js';
import { montarConfiguracoes } from './telas/configuracoes.js';

const ITENS_MENU = [
  { rota: 'dashboard', rotulo: 'Painel', icone: Icone.painel },
  { rota: 'clientes', rotulo: 'Clientes', icone: Icone.clientes },
  { rota: 'nova-campanha', rotulo: 'Nova campanha', icone: Icone.campanha },
  { rota: 'historico', rotulo: 'Histórico', icone: Icone.historico },
  { rota: 'configuracoes', rotulo: 'Configurações', icone: Icone.config },
];

const MAPA_TELAS = {
  dashboard: montarDashboard,
  clientes: montarClientes,
  'nova-campanha': montarNovaCampanha,
  envio: montarEnvio,
  historico: montarHistorico,
  configuracoes: montarConfiguracoes,
};

function montarShell(nomeRota) {
  const raiz = document.getElementById('raiz');
  raiz.innerHTML = `
    <aside class="barra-lateral" id="barra-lateral">
      <div class="marca">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#C7DDBB" stroke-width="1.8"><path d="M12 21V10"/><path d="M12 10C12 6 9 4 5 4c0 4.2 2.7 7 7 7Z"/><path d="M12 13c0-4.5 3.4-6.7 7.5-6.7-.2 4.9-3.3 7.5-7.5 6.7Z"/></svg>
        <div><strong>Vale Verde</strong><span>Painel de disparos</span></div>
      </div>
      <nav id="nav-menu"></nav>
      <div style="flex:1"></div>
      <button class="nav-item" id="btn-sair">${Icone.saida} Sair</button>
      <div class="status-conexao-mini" id="status-mini"></div>
    </aside>
    <main class="conteudo" id="conteudo"></main>
  `;

  const navMenu = raiz.querySelector('#nav-menu');
  navMenu.innerHTML = ITENS_MENU.map((item) =>
    `<button class="nav-item ${item.rota === nomeRota ? 'ativo' : ''}" data-rota="${item.rota}">${item.icone}${item.rotulo}</button>`
  ).join('');
  navMenu.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-rota]');
    if (botao) navegar(botao.dataset.rota);
  });

  raiz.querySelector('#btn-sair').addEventListener('click', () => {
    estado.conexaoWhatsapp = { status: 'desconectado', numero: null };
    navegar('login');
  });

  const conectado = estado.conexaoWhatsapp.status === 'conectado';
  raiz.querySelector('#status-mini').innerHTML =
    `<div class="linha"><span class="ponto ${conectado ? 'on' : ''}"></span>${conectado ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</div>
     <small>${conectado ? estado.conexaoWhatsapp.numero : 'Vá em Sair para reconectar'}</small>`;

  return raiz.querySelector('#conteudo');
}

function resolverRota(nomeRota) {
  if (nomeRota === 'login' || estado.conexaoWhatsapp.status !== 'conectado') {
    const raiz = document.getElementById('raiz');
    raiz.innerHTML = '';
    montarLogin(raiz);
    return;
  }
  const conteudo = montarShell(nomeRota);
  const montarTela = MAPA_TELAS[nomeRota] ?? montarDashboard;
  montarTela(conteudo);
}

document.addEventListener('DOMContentLoaded', () => iniciarRoteador(resolverRota));
