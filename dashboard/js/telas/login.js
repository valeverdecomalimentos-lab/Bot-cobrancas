import { estado, atualizarConexaoWhatsapp } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';

const CONFIG_STATUS = {
  desconectado: { rotulo: 'WhatsApp desconectado', cor: 'var(--vv-erro)' },
  iniciando: { rotulo: 'Iniciando conexao', cor: 'var(--vv-alerta)' },
  aguardando_qr: { rotulo: 'Escaneie o QR Code', cor: 'var(--vv-alerta)' },
  conectado: { rotulo: 'WhatsApp conectado', cor: 'var(--vv-sucesso)' },
};

export function montarLogin(alvo) {
  const tela = paraElemento(`
    <div class="tela-login">
      <div class="painel-login cartao">
        <div class="marca-login">
          <img src="../logoi.png" alt="Vale Verde" class="marca-imagem">
          <strong>Vale Verde</strong>
          <span>Painel de disparos WhatsApp</span>
        </div>
        <div id="area-status"></div>
      </div>
    </div>`);
  alvo.appendChild(tela);
  const areaStatus = tela.querySelector('#area-status');

  function renderizar() {
    const conexao = estado.conexaoWhatsapp;
    const cfg = CONFIG_STATUS[conexao.status] || CONFIG_STATUS.desconectado;
    if (conexao.status === 'conectado') {
      areaStatus.innerHTML = `
        <div class="moldura-qr" style="border-color:var(--vv-sucesso)"><span class="icone-conectado">OK</span></div>
        <div class="status-linha"><span class="ponto" style="background:${cfg.cor}"></span>${cfg.rotulo}</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil);margin-bottom:18px">${escaparHtml(conexao.numero || 'Sessao autenticada e pronta para envios.')}</p>
        <button class="btn btn--primario" id="btn-entrar" style="width:100%">Entrar no painel</button>`;
      areaStatus.querySelector('#btn-entrar').addEventListener('click', () => navegar('dashboard'));
      return;
    }

    if (conexao.status === 'aguardando_qr' && conexao.qrDataUrl) {
      areaStatus.innerHTML = `
        <div class="moldura-qr"><img src="${conexao.qrDataUrl}" alt="QR Code para conectar o WhatsApp"><div class="varredura"></div></div>
        <div class="status-linha"><span class="spinner"></span>${cfg.rotulo}</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil)">No WhatsApp da empresa, abra Aparelhos conectados e escolha Conectar um aparelho.</p>`;
      return;
    }

    areaStatus.innerHTML = `
      <div class="moldura-qr"><span class="spinner"></span></div>
      <div class="status-linha"><span class="ponto" style="background:${cfg.cor}"></span>${cfg.rotulo}</div>
      <p style="font-size:13px;color:var(--vv-texto-sutil);margin-bottom:16px">O QR real sera exibido aqui assim que a conexao iniciar.</p>
      <button class="btn btn--primario" id="btn-iniciar" style="width:100%" ${conexao.status === 'iniciando' ? 'disabled' : ''}>${conexao.status === 'iniciando' ? 'Iniciando...' : 'Gerar QR Code'}</button>
      <button class="btn btn--fantasma" id="btn-acessar-painel" style="width:100%;margin-top:8px">Acessar painel</button>`;
    areaStatus.querySelector('#btn-iniciar').addEventListener('click', async () => {
      try {
        atualizarConexaoWhatsapp({ status: 'iniciando', erro: null });
        renderizar();
        const status = await api.startWhatsapp();
        atualizarConexaoWhatsapp(status);
        renderizar();
      } catch (error) {
        atualizarConexaoWhatsapp({ status: 'desconectado', erro: error.message });
        renderizar();
        mostrarToast(error.message || 'Nao foi possivel iniciar o WhatsApp.', 'erro');
      }
    });
    areaStatus.querySelector('#btn-acessar-painel').addEventListener('click', () => navegar('dashboard'));
  }

  renderizar();
}
