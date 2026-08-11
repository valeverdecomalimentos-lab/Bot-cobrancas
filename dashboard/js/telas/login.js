import { estado, atualizarConexaoWhatsapp, barramento } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';

const INTERVALO_SINCRONIZACAO_MS = 2_000;
const LIMITE_INICIALIZACAO_MS = 35_000;

const CONFIG_STATUS = {
  desconectado: { rotulo: 'WhatsApp desconectado', cor: 'var(--vv-erro)' },
  iniciando: { rotulo: 'Iniciando conexão', cor: 'var(--vv-alerta)' },
  aguardando_qr: { rotulo: 'Escaneie o QR Code', cor: 'var(--vv-alerta)' },
  conectado: { rotulo: 'WhatsApp conectado', cor: 'var(--vv-sucesso)' },
};

function mensagemDeErro(erro, alternativa) {
  return String(erro?.message || erro || alternativa);
}

function qrCodeSeguro(valor) {
  const url = String(valor || '').trim();
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(url) ? url : '';
}

export function montarLogin(alvo) {
  const tela = paraElemento(`
    <div class="tela-login">
      <main class="painel-login cartao" aria-labelledby="titulo-login">
        <div class="marca-login">
          <img src="../logoi.png" alt="Vale Verde" class="marca-imagem">
          <strong id="titulo-login" role="heading" aria-level="1">Vale Verde</strong>
          <span>Painel de disparos WhatsApp</span>
        </div>
        <div id="area-status" role="status" aria-live="polite" aria-atomic="true"></div>
      </main>
    </div>`);
  alvo.appendChild(tela);
  const areaStatus = tela.querySelector('#area-status');
  let encerrado = false;
  let temporizadorSincronizacao = null;
  let sincronizacaoEmAndamento = false;
  let acaoEmAndamento = '';
  let erroDeSincronizacao = '';
  let inicioDaTentativa = ['iniciando', 'aguardando_qr'].includes(estado.conexaoWhatsapp.status)
    ? Date.now()
    : 0;
  let ultimaAssinaturaVisual = '';

  function tentativaDemorada() {
    if (!inicioDaTentativa) return false;
    if (!['iniciando', 'aguardando_qr'].includes(estado.conexaoWhatsapp.status)) return false;
    return Date.now() - inicioDaTentativa >= LIMITE_INICIALIZACAO_MS;
  }

  function assinaturaVisual() {
    const conexao = estado.conexaoWhatsapp;
    return JSON.stringify([
      conexao.status,
      conexao.numero,
      conexao.qrDataUrl,
      conexao.erro,
      erroDeSincronizacao,
      acaoEmAndamento,
      tentativaDemorada(),
    ]);
  }

  function aplicarStatus(status = {}) {
    if (encerrado || !status || typeof status !== 'object') return;
    const statusAnterior = estado.conexaoWhatsapp.status;
    atualizarConexaoWhatsapp(status);
    const statusAtual = estado.conexaoWhatsapp.status;
    const aguardando = ['iniciando', 'aguardando_qr'].includes(statusAtual);
    if (aguardando && !['iniciando', 'aguardando_qr'].includes(statusAnterior)) inicioDaTentativa = Date.now();
    if (!aguardando) inicioDaTentativa = 0;
    erroDeSincronizacao = '';
    renderizarSeNecessario();
  }

  function aplicarRetornoDaInicializacao(status = {}) {
    const atual = estado.conexaoWhatsapp.status;
    const recebido = status?.status;
    const retornoAtrasado = (atual === 'aguardando_qr' && recebido === 'iniciando')
      || (atual === 'conectado' && recebido !== 'conectado');
    if (!retornoAtrasado) aplicarStatus(status);
  }

  async function iniciarWhatsapp({ reiniciarSessao = false } = {}) {
    if (acaoEmAndamento || encerrado) return;
    if (reiniciarSessao) {
      const confirmado = window.confirm(
        'Gerar um novo QR Code encerra a sessão atual do WhatsApp neste computador. Deseja continuar?',
      );
      if (!confirmado) return;
    }

    acaoEmAndamento = reiniciarSessao ? 'resetando' : 'iniciando';
    erroDeSincronizacao = '';
    renderizarSeNecessario(true);
    try {
      if (reiniciarSessao) {
        const statusReset = await api.resetWhatsapp();
        aplicarStatus(statusReset);
      }
      inicioDaTentativa = Date.now();
      atualizarConexaoWhatsapp({ status: 'iniciando', qrDataUrl: null, erro: null });
      acaoEmAndamento = 'iniciando';
      renderizarSeNecessario(true);
      aplicarRetornoDaInicializacao(await api.startWhatsapp());
    } catch (error) {
      const mensagem = mensagemDeErro(error, 'Não foi possível iniciar o WhatsApp.');
      inicioDaTentativa = 0;
      atualizarConexaoWhatsapp({ status: 'desconectado', qrDataUrl: null, erro: mensagem });
      mostrarToast(mensagem, 'erro');
    } finally {
      acaoEmAndamento = '';
      renderizarSeNecessario(true);
    }
  }

  function adicionarAcoesComuns() {
    areaStatus.querySelector('#btn-acessar-painel')?.addEventListener('click', () => navegar('dashboard'));
    areaStatus.querySelector('#btn-iniciar')?.addEventListener('click', () => iniciarWhatsapp());
    areaStatus.querySelector('#btn-gerar-novo-qr')?.addEventListener('click', () => iniciarWhatsapp({ reiniciarSessao: true }));
    areaStatus.querySelector('#btn-entrar')?.addEventListener('click', () => navegar('dashboard'));
  }

  function renderizar() {
    if (encerrado || !areaStatus.isConnected) return;
    ultimaAssinaturaVisual = assinaturaVisual();
    const conexao = estado.conexaoWhatsapp;
    const cfg = CONFIG_STATUS[conexao.status] || CONFIG_STATUS.desconectado;
    const ocupado = Boolean(acaoEmAndamento);
    const demorando = tentativaDemorada();
    const qrDataUrl = qrCodeSeguro(conexao.qrDataUrl);
    const qrInvalido = conexao.status === 'aguardando_qr' && Boolean(conexao.qrDataUrl) && !qrDataUrl;
    const erroAtual = String(conexao.erro || erroDeSincronizacao || '').trim();
    areaStatus.setAttribute('aria-busy', String(ocupado || conexao.status === 'iniciando'));

    if (conexao.status === 'conectado') {
      areaStatus.innerHTML = `
        <div class="moldura-qr" style="border-color:var(--vv-sucesso)" aria-hidden="true"><span class="icone-conectado">OK</span></div>
        <div class="status-linha"><span class="ponto" style="background:${cfg.cor}" aria-hidden="true"></span>${cfg.rotulo}</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil);margin-bottom:18px">${escaparHtml(conexao.numero || 'Sessão autenticada e pronta para envios.')}</p>
        <button class="btn btn--primario" id="btn-entrar" type="button" style="width:100%">Entrar no painel</button>
        <button class="btn btn--fantasma" id="btn-gerar-novo-qr" type="button" style="width:100%;margin-top:8px" ${ocupado ? 'disabled aria-disabled="true" aria-busy="true"' : ''}>Gerar novo QR</button>`;
      adicionarAcoesComuns();
      return;
    }

    if (conexao.status === 'aguardando_qr' && qrDataUrl) {
      areaStatus.innerHTML = `
        <div class="moldura-qr"><img id="imagem-qr-whatsapp" alt="QR Code para conectar o WhatsApp"><div class="varredura" aria-hidden="true"></div></div>
        <div class="status-linha"><span class="spinner" aria-hidden="true"></span>${cfg.rotulo}</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil)">No WhatsApp da empresa, abra <strong>Aparelhos conectados</strong> e escolha <strong>Conectar um aparelho</strong>.</p>
        <p style="font-size:12px;color:var(--vv-texto-fraco);margin-top:8px">Mantenha esta tela aberta até a confirmação da conexão.</p>`;
      areaStatus.querySelector('#imagem-qr-whatsapp').src = qrDataUrl;
      return;
    }

    const precisaDeNovoQr = Boolean(erroAtual || demorando || qrInvalido);
    let orientacao = 'A abertura do WhatsApp costuma levar de 10 a 30 segundos. Mantenha o aplicativo aberto.';
    let mensagemAcionavel = erroAtual;
    if (qrInvalido) {
      mensagemAcionavel = 'O QR Code recebido está em um formato inválido. Gere um novo código para tentar novamente.';
    } else if (demorando && !mensagemAcionavel) {
      mensagemAcionavel = 'A conexão demorou mais que o esperado. Verifique a internet e gere um novo QR Code.';
    } else if (erroAtual) {
      orientacao = 'Verifique a internet e se o WhatsApp não está bloqueado. Se o problema continuar, gere uma nova sessão.';
    }
    const erroHtml = mensagemAcionavel
      ? `<p role="alert" style="font-size:13px;color:var(--vv-erro);margin-bottom:10px">${escaparHtml(mensagemAcionavel)}</p>`
      : '';
    const rotuloAcao = acaoEmAndamento === 'resetando'
      ? 'Limpando sessão...'
      : acaoEmAndamento === 'iniciando' || (conexao.status === 'iniciando' && !precisaDeNovoQr)
        ? 'Iniciando...'
        : precisaDeNovoQr
          ? 'Gerar novo QR'
          : 'Gerar QR Code';
    const idAcao = precisaDeNovoQr ? 'btn-gerar-novo-qr' : 'btn-iniciar';
    const desabilitado = ocupado || (conexao.status === 'iniciando' && !precisaDeNovoQr);

    areaStatus.innerHTML = `
      <div class="moldura-qr" aria-hidden="true"><span class="spinner"></span></div>
      <div class="status-linha"><span class="ponto" style="background:${cfg.cor}" aria-hidden="true"></span>${cfg.rotulo}</div>
      <p style="font-size:13px;color:var(--vv-texto-sutil);margin-bottom:12px">${escaparHtml(orientacao)}</p>
      ${erroHtml}
      <button class="btn btn--primario" id="${idAcao}" type="button" style="width:100%" ${desabilitado ? 'disabled aria-disabled="true" aria-busy="true"' : ''}>${rotuloAcao}</button>
      <button class="btn btn--fantasma" id="btn-acessar-painel" type="button" style="width:100%;margin-top:8px">Acessar painel</button>`;
    adicionarAcoesComuns();
  }

  function renderizarSeNecessario(forcar = false) {
    if (forcar || assinaturaVisual() !== ultimaAssinaturaVisual) renderizar();
  }

  async function sincronizarStatus() {
    if (encerrado || sincronizacaoEmAndamento) return;
    sincronizacaoEmAndamento = true;
    try {
      aplicarStatus(await api.getWhatsappStatus());
    } catch (error) {
      erroDeSincronizacao = mensagemDeErro(
        error,
        'Não foi possível consultar o WhatsApp. Verifique a conexão e tente novamente.',
      );
      renderizarSeNecessario();
    } finally {
      sincronizacaoEmAndamento = false;
    }
  }

  function agendarSincronizacao() {
    if (encerrado) return;
    window.clearTimeout(temporizadorSincronizacao);
    temporizadorSincronizacao = window.setTimeout(async () => {
      await sincronizarStatus();
      renderizarSeNecessario();
      agendarSincronizacao();
    }, INTERVALO_SINCRONIZACAO_MS);
  }

  const removerOuvinteStatus = barramento.on('whatsapp:status', aplicarStatus);
  renderizar();
  sincronizarStatus();
  agendarSincronizacao();

  return () => {
    encerrado = true;
    window.clearTimeout(temporizadorSincronizacao);
    removerOuvinteStatus();
  };
}
