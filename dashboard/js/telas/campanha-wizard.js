import { estado, formatarMoeda, formatarTelefone, TIPOS_CHAVE_PIX } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';
import { textoDaResposta } from '../nucleo/markdown.js';
import { Icone } from '../nucleo/icones.js';

const ETAPAS = ['Tipo', 'Mensagem', 'Destinatários', 'Teste', 'Confirmação'];
const PLACEHOLDERS = ['{{nome}}', '{{valor}}', '{{saldo_devedor}}', '{{pix_nome_favorecido}}', '{{pix_tipo}}', '{{pix_chave}}', '{{telefone}}', '{{cpf}}'];

function saldo(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

function temTelefone(cliente) {
  return Boolean(String(cliente.telefone || '').replace(/\D/g, ''));
}

function destinatariosElegiveis(tipo) {
  if (tipo === 'cobranca') {
    return estado.clientes.filter((cliente) => temTelefone(cliente) && (cliente.status === 'devedor' || saldo(cliente) > 0) && saldo(cliente) >= 50);
  }
  return estado.clientes.filter(temTelefone);
}

function montarPrevia(mensagem, cliente) {
  if (!cliente) return 'Importe clientes para visualizar os placeholders com dados reais.';
  const pix = estado.config.pix || {};
  const nomeFavorecido = pix.nomeFavorecido || estado.config.nomeFavorecido || '';
  const chavePix = pix.chave || estado.config.chavePix || '';
  const tipoPix = pix.tipo || estado.config.tipoChavePix || 'aleatoria';
  const valor = formatarMoeda(saldo(cliente)).replace(/^R\$\s?/, '');
  return String(mensagem || '')
    .replaceAll('{{nome}}', cliente.nome || '')
    .replaceAll('{{primeiro_nome}}', String(cliente.nome || '').split(' ')[0] || '')
    .replaceAll('{{valor}}', valor)
    .replaceAll('{{saldo_devedor}}', valor)
    .replaceAll('{{pix_nome_favorecido}}', nomeFavorecido || 'configure o favorecido')
    .replaceAll('{{nome_favorecido_pix}}', nomeFavorecido || 'configure o favorecido')
    .replaceAll('{{pix_tipo}}', TIPOS_CHAVE_PIX[tipoPix] || TIPOS_CHAVE_PIX.aleatoria)
    .replaceAll('{{tipo_chave_pix}}', TIPOS_CHAVE_PIX[tipoPix] || TIPOS_CHAVE_PIX.aleatoria)
    .replaceAll('{{pix_chave}}', chavePix || 'configure a chave PIX')
    .replaceAll('{{chave_pix}}', chavePix || 'configure a chave PIX')
    .replaceAll('{{telefone}}', formatarTelefone(cliente.telefone))
    .replaceAll('{{cpf}}', cliente.cpf || '');
}

export function montarNovaCampanha(alvo) {
  const rascunhoIA = estado.rascunhoCampanhaIA && typeof estado.rascunhoCampanhaIA === 'object'
    ? estado.rascunhoCampanhaIA
    : null;
  const rascunho = {
    tipo: rascunhoIA?.tipo || estado.novaCampanhaTipoInicial || null,
    templateId: '',
    mensagem: String(rascunhoIA?.mensagem || ''),
    recipientIdsSugeridos: Array.isArray(rascunhoIA?.recipientIds) ? rascunhoIA.recipientIds.map(String) : [],
    destinatarios: [],
    telefoneTeste: '',
    testeEnviado: false,
    testeId: '',
  };
  let etapaAtual = rascunho.tipo ? 1 : 0;
  estado.novaCampanhaTipoInicial = null;
  estado.rascunhoCampanhaIA = null;

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Nova campanha</h1><p class="legenda">Monte, valide e somente depois libere o envio para a base.</p></div></div>
      <div class="trilha-etapas" id="trilha"></div>
      <div id="corpo-etapa"></div>
    </div>`);
  alvo.appendChild(tela);
  const trilha = tela.querySelector('#trilha');
  const corpo = tela.querySelector('#corpo-etapa');

  function invalidarTeste() {
    rascunho.testeEnviado = false;
    rascunho.testeId = '';
  }

  function renderizarTrilha() {
    trilha.innerHTML = ETAPAS.map((nome, indice) => `
      <div class="etapa ${indice < etapaAtual ? 'concluida' : ''} ${indice === etapaAtual ? 'ativa' : ''}">
        <span class="num">${indice < etapaAtual ? 'OK' : indice + 1}</span>${nome}
      </div>${indice < ETAPAS.length - 1 ? '<div class="traco"></div>' : ''}`).join('');
  }

  function irPara(passo) {
    etapaAtual = passo;
    renderizarTrilha();
    renderizarEtapa();
    corpo.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function etapaTipo() {
    const cobranca = destinatariosElegiveis('cobranca').length;
    const promocao = destinatariosElegiveis('promocao').length;
    const el = paraElemento(`
      <div>
        <div class="cartoes-tipo">
          <button class="cartao cartao-tipo ${rascunho.tipo === 'cobranca' ? 'selecionado' : ''}" data-tipo="cobranca">
            <span class="icone">${Icone.alerta}</span><h3>Cobrança</h3><p><strong>${cobranca} destinatários</strong> com dívida de pelo menos R$ 50,00.</p>
          </button>
          <button class="cartao cartao-tipo ${rascunho.tipo === 'promocao' ? 'selecionado' : ''}" data-tipo="promocao">
            <span class="icone">${Icone.campanha}</span><h3>Promoção</h3><p><strong>${promocao} clientes</strong> com telefone válido.</p>
          </button>
        </div>
        <div class="acoes-rodape"><button class="btn btn--primario" id="btn-avancar" ${rascunho.tipo ? '' : 'disabled'}>Avançar ${Icone.seta}</button></div>
      </div>`);
    el.querySelectorAll('.cartao-tipo').forEach((cartao) => cartao.addEventListener('click', () => {
      rascunho.tipo = cartao.dataset.tipo;
      rascunho.destinatarios = [];
      rascunho.recipientIdsSugeridos = [];
      invalidarTeste();
      el.querySelectorAll('.cartao-tipo').forEach((item) => item.classList.remove('selecionado'));
      cartao.classList.add('selecionado');
      el.querySelector('#btn-avancar').disabled = false;
    }));
    el.querySelector('#btn-avancar').addEventListener('click', () => irPara(1));
    return el;
  }

  function etapaMensagem() {
    const clienteExemplo = destinatariosElegiveis(rascunho.tipo)[0];
    const opcoesTemplates = estado.config.templates.map((template) => `<option value="${escaparHtml(template.id)}" ${String(template.id) === String(rascunho.templateId) ? 'selected' : ''}>${escaparHtml(template.nome)}</option>`).join('');
    const el = paraElemento(`
      <div>
        <div class="editor-mensagem">
          <div>
            <label for="seletor-template">Template salvo</label>
            <div class="linha-controles">
              <select id="seletor-template"><option value="">Mensagem personalizada</option>${opcoesTemplates}</select>
              <button class="btn btn--secundario" id="btn-templates" type="button">Gerenciar</button>
              <button class="btn btn--secundario" id="btn-gerar-ia" type="button" ${estado.gemini.disponivel ? '' : 'disabled'}>${Icone.sparkles} Gerar com IA</button>
            </div>
            <label for="texto-mensagem">Mensagem</label>
            <div class="placeholders">${PLACEHOLDERS.map((placeholder) => `<button class="chip-placeholder" type="button" data-placeholder="${placeholder}">${placeholder}</button>`).join('')}</div>
            <textarea id="texto-mensagem" rows="8" placeholder="Escreva a mensagem que será enviada" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">${escaparHtml(rascunho.mensagem)}</textarea>
            <small>O WhatsApp receberá somente este texto, com os placeholders substituídos. O sistema não adiciona avisos nem rodapés.</small>
          </div>
          <div>
            <label>Prévia com dados reais</label>
            <div class="previa-mensagem"><div class="bolha-whats" id="bolha-previa"></div></div>
          </div>
        </div>
        <div class="acoes-rodape acoes-rodape--entre"><button class="btn btn--secundario" id="btn-voltar">Voltar</button><button class="btn btn--primario" id="btn-avancar" ${rascunho.mensagem.trim() ? '' : 'disabled'}>Avançar ${Icone.seta}</button></div>
      </div>`);
    const textarea = el.querySelector('#texto-mensagem');
    const seletor = el.querySelector('#seletor-template');
    const botaoAvancar = el.querySelector('#btn-avancar');
    function focarNoFim() {
      const fim = textarea.value.length;
      textarea.focus({ preventScroll: true });
      if (typeof textarea.setSelectionRange === 'function') {
        textarea.setSelectionRange(fim, fim);
      }
    }
    function aplicarTexto(texto) {
      textarea.value = String(texto || '');
      focarNoFim();
      atualizar();
    }
    function inserirTexto(texto) {
      const inicio = textarea.selectionStart ?? textarea.value.length;
      const fim = textarea.selectionEnd ?? inicio;
      const inserido = String(texto || '');
      textarea.value = `${textarea.value.slice(0, inicio)}${inserido}${textarea.value.slice(fim)}`;
      const novaPosicao = inicio + inserido.length;
      textarea.focus({ preventScroll: true });
      if (typeof textarea.setSelectionRange === 'function') {
        textarea.setSelectionRange(novaPosicao, novaPosicao);
      }
      atualizar();
    }
    const atualizar = () => {
      if (rascunho.mensagem !== textarea.value) invalidarTeste();
      rascunho.mensagem = textarea.value;
      el.querySelector('#bolha-previa').innerHTML = `${escaparHtml(montarPrevia(rascunho.mensagem, clienteExemplo))}<time>--:--</time>`;
      botaoAvancar.disabled = !rascunho.mensagem.trim() || !clienteExemplo;
    };
    seletor.addEventListener('change', () => {
      rascunho.templateId = seletor.value;
      const template = estado.config.templates.find((item) => String(item.id) === String(seletor.value));
      if (template) aplicarTexto(template.texto);
      atualizar();
    });
    textarea.addEventListener('input', atualizar);
    el.querySelectorAll('.chip-placeholder').forEach((chip) => chip.addEventListener('click', () => {
      inserirTexto(chip.dataset.placeholder);
    }));
    el.querySelector('#btn-templates').addEventListener('click', () => navegar('configuracoes'));
    el.querySelector('#btn-gerar-ia').addEventListener('click', async (event) => {
      const botao = event.currentTarget;
      botao.disabled = true;
      botao.textContent = 'Gerando...';
      try {
        aplicarTexto(textoDaResposta(await api.suggestCampaignMessage({ tipo: rascunho.tipo, mensagemAtual: textarea.value })));
        mostrarToast('Mensagem gerada para sua revisão.', 'sucesso');
      } catch (error) {
        mostrarToast(error.message || 'Não foi possível gerar a mensagem.', 'erro');
      } finally {
        if (el.isConnected) {
          botao.disabled = !estado.gemini.disponivel;
          botao.innerHTML = `${Icone.sparkles} Gerar com IA`;
        }
      }
    });
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(0));
    botaoAvancar.addEventListener('click', () => {
      const sugeridos = new Set(rascunho.recipientIdsSugeridos);
      rascunho.destinatarios = destinatariosElegiveis(rascunho.tipo).map((cliente) => ({
        ...cliente,
        incluido: !sugeridos.size || sugeridos.has(String(cliente.id)),
      }));
      irPara(2);
    });
    atualizar();
    return el;
  }

  function etapaDestinatarios() {
    const el = paraElemento(`
      <div>
        ${rascunho.tipo === 'cobranca' ? `<div class="aviso-caixa">${Icone.aviso}<span>Clientes com saldo abaixo de <strong>R$ 50,00</strong> foram excluidos automaticamente da cobranca.</span></div>` : ''}
        <p class="linha-resumo"><strong id="contador-revisao"></strong> destinatários selecionados.</p>
        <div class="lista-revisao" id="lista-revisao"></div>
        <div class="acoes-rodape acoes-rodape--entre"><button class="btn btn--secundario" id="btn-voltar">Voltar</button><button class="btn btn--primario" id="btn-avancar">Avançar ${Icone.seta}</button></div>
      </div>`);
    const lista = el.querySelector('#lista-revisao');
    const contador = el.querySelector('#contador-revisao');
    const atualizarContador = () => { contador.textContent = rascunho.destinatarios.filter((item) => item.incluido).length; };
    if (!rascunho.destinatarios.length) {
      lista.innerHTML = `<div class="estado-vazio"><p>Não há destinatários elegíveis para esta campanha.</p></div>`;
    } else {
      lista.innerHTML = rascunho.destinatarios.map((cliente, indice) => `<label class="linha-revisao"><input type="checkbox" data-indice="${indice}" ${cliente.incluido ? 'checked' : ''}><span>${escaparHtml(cliente.nome || 'Sem nome')}</span><span class="linha-revisao__telefone">${formatarTelefone(cliente.telefone)}</span></label>`).join('');
    }
    lista.addEventListener('change', (event) => {
      const indice = event.target.dataset.indice;
      if (indice === undefined) return;
      rascunho.destinatarios[Number(indice)].incluido = event.target.checked;
      atualizarContador();
    });
    atualizarContador();
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(1));
    el.querySelector('#btn-avancar').addEventListener('click', () => {
      if (!rascunho.destinatarios.some((item) => item.incluido)) return mostrarToast('Selecione pelo menos um destinatário.', 'erro');
      irPara(3);
    });
    return el;
  }

  function etapaTeste() {
    const exemplo = rascunho.destinatarios.find((cliente) => cliente.incluido) || destinatariosElegiveis(rascunho.tipo)[0];
    const conectado = estado.conexaoWhatsapp.status === 'conectado';
    const el = paraElemento(`
      <div>
        <section class="teste-campanha" aria-labelledby="titulo-teste">
          <div class="teste-campanha__cabecalho"><span class="teste-campanha__icone">${Icone.check}</span><div><h2 id="titulo-teste">Teste no WhatsApp</h2><p><strong>Envie e confira a mensagem antes de liberar o disparo em massa.</strong></p></div></div>
          <div class="teste-campanha__corpo">
            <div class="campo"><label for="telefone-teste">Número de WhatsApp para teste</label><input type="text" id="telefone-teste" inputmode="tel" placeholder="DDD + número" value="${escaparHtml(rascunho.telefoneTeste)}"><small>O teste usa os dados reais de um destinatário elegível para renderizar os placeholders.</small></div>
            <div class="previa-mensagem"><div class="bolha-whats">${escaparHtml(montarPrevia(rascunho.mensagem, exemplo))}<time>--:--</time></div></div>
          </div>
          <div class="teste-campanha__acoes"><button class="btn btn--secundario" id="btn-teste" type="button" ${conectado ? '' : 'disabled'}>${Icone.play} Enviar mensagem teste</button><span id="resultado-teste" class="teste-campanha__resultado">${conectado ? 'Nenhum teste confirmado para esta mensagem.' : 'Conecte o WhatsApp para enviar o teste.'}</span></div>
        </section>
        <div class="acoes-rodape acoes-rodape--entre"><button class="btn btn--secundario" id="btn-voltar">Voltar</button><button class="btn btn--primario" id="btn-avancar" ${rascunho.testeEnviado ? '' : 'disabled'}>Confirmar campanha ${Icone.seta}</button></div>
      </div>`);
    const campoTelefone = el.querySelector('#telefone-teste');
    const botaoTeste = el.querySelector('#btn-teste');
    const botaoAvancar = el.querySelector('#btn-avancar');
    const resultadoTeste = el.querySelector('#resultado-teste');
    campoTelefone.addEventListener('input', () => {
      if (rascunho.telefoneTeste !== campoTelefone.value) invalidarTeste();
      rascunho.telefoneTeste = campoTelefone.value;
      botaoAvancar.disabled = true;
      resultadoTeste.textContent = 'Número alterado. Envie um novo teste para liberar a campanha.';
    });
    botaoTeste.addEventListener('click', async () => {
      const telefone = campoTelefone.value.trim();
      if (!telefone) return mostrarToast('Informe o número de teste.', 'erro');
      botaoTeste.disabled = true;
      botaoTeste.textContent = 'Enviando teste...';
      try {
        const resultado = await api.sendTest({
          telefone,
          mensagem: rascunho.mensagem,
          clienteExemploId: exemplo?.id,
        });
        rascunho.telefoneTeste = telefone;
        rascunho.testeEnviado = true;
        rascunho.testeId = resultado.testeId;
        resultadoTeste.innerHTML = `<strong>Teste enviado com sucesso.</strong> A campanha está liberada para confirmação.`;
        resultadoTeste.classList.add('confirmado');
        botaoAvancar.disabled = false;
        mostrarToast('Mensagem de teste enviada', 'sucesso');
      } catch (error) {
        invalidarTeste();
        resultadoTeste.textContent = error.message || 'Não foi possível enviar o teste.';
        resultadoTeste.classList.remove('confirmado');
        botaoAvancar.disabled = true;
        mostrarToast(error.message || 'Não foi possível enviar o teste.', 'erro');
      } finally {
        if (el.isConnected) {
          botaoTeste.disabled = !conectado;
          botaoTeste.innerHTML = `${Icone.play} Enviar mensagem teste`;
        }
      }
    });
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(2));
    botaoAvancar.addEventListener('click', () => {
      if (!rascunho.testeEnviado || !rascunho.testeId) return mostrarToast('Envie o teste antes de confirmar a campanha.', 'erro');
      irPara(4);
    });
    return el;
  }

  function etapaConfirmacao() {
    const selecionados = rascunho.destinatarios.filter((item) => item.incluido);
    const intervaloMedio = (Number(estado.config.intervaloMin) + Number(estado.config.intervaloMax)) / 2;
    const minutos = Math.max(1, Math.ceil((selecionados.length * intervaloMedio) / 60));
    const el = paraElemento(`
      <div class="cartao confirmacao-campanha">
        <div class="confirmacao-campanha__cabecalho"><span>${Icone.check}</span><div><h2>Pronto para disparar</h2><p>Teste confirmado em <strong>${escaparHtml(formatarTelefone(rascunho.telefoneTeste))}</strong>.</p></div></div>
        <dl class="confirmacao-campanha__dados"><div><dt>Destinatários</dt><dd>${selecionados.length}</dd></div><div><dt>Tempo estimado</dt><dd>${minutos} min</dd></div><div><dt>Intervalo</dt><dd>${estado.config.intervaloMin} a ${estado.config.intervaloMax} s</dd></div></dl>
        <div class="aviso-caixa">${Icone.aviso}<span>O envio acontece um a um. A mensagem validada no teste será enviada para a seleção atual.</span></div>
        <div class="acoes-rodape acoes-rodape--entre"><button class="btn btn--secundario" id="btn-voltar">Voltar</button><button class="btn btn--primario" id="btn-disparar">${Icone.play} Disparar campanha</button></div>
      </div>`);
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(3));
    el.querySelector('#btn-disparar').addEventListener('click', () => {
      estado.campanhaEmAndamento = {
        id: `campanha-${Date.now()}`,
        tipo: rascunho.tipo,
        mensagem: rascunho.mensagem,
        recipientIds: selecionados.map((cliente) => cliente.id),
        testeId: rascunho.testeId,
        totalPlanejado: selecionados.length,
        intervaloMin: estado.config.intervaloMin,
        intervaloMax: estado.config.intervaloMax,
        iniciada: false,
      };
      navegar('envio');
    });
    return el;
  }

  function renderizarEtapa() {
    corpo.innerHTML = '';
    const etapas = [etapaTipo, etapaMensagem, etapaDestinatarios, etapaTeste, etapaConfirmacao];
    corpo.appendChild(etapas[etapaAtual]());
  }

  renderizarTrilha();
  renderizarEtapa();
}
