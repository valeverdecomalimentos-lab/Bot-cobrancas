import { estado, formatarMoeda, formatarTelefone } from '../nucleo/estado.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const ETAPAS = ['Tipo', 'Mensagem', 'Revisão', 'Confirmação'];
const PLACEHOLDERS = ['{{nome}}', '{{valor}}'];

export function montarNovaCampanha(alvo) {
  const rascunho = {
    tipo: estado.novaCampanhaTipoInicial ?? null,
    mensagem: '',
    destinatarios: [],
  };
  let etapaAtual = rascunho.tipo ? 1 : 0;

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Nova campanha</h1><p class="legenda">Cobrança ou promoção — em 4 passos simples</p></div></div>
      <div class="trilha-etapas" id="trilha"></div>
      <div id="corpo-etapa"></div>
    </div>`);
  alvo.appendChild(tela);

  const trilha = tela.querySelector('#trilha');
  const corpo = tela.querySelector('#corpo-etapa');

  function renderizarTrilha() {
    trilha.innerHTML = ETAPAS.map((nome, i) => `
      <div class="etapa ${i < etapaAtual ? 'concluida' : ''} ${i === etapaAtual ? 'ativa' : ''}">
        <span class="num">${i < etapaAtual ? '✓' : i + 1}</span>${nome}
      </div>${i < ETAPAS.length - 1 ? '<div class="traco"></div>' : ''}
    `).join('');
  }

  function irPara(passo) { etapaAtual = passo; renderizarTrilha(); renderizarEtapa(); corpo.scrollIntoView({ block: 'start', behavior: 'smooth' }); }

  function renderizarEtapa() {
    corpo.innerHTML = '';
    if (etapaAtual === 0) corpo.appendChild(etapaTipo());
    if (etapaAtual === 1) corpo.appendChild(etapaMensagem());
    if (etapaAtual === 2) corpo.appendChild(etapaRevisao());
    if (etapaAtual === 3) corpo.appendChild(etapaConfirmacao());
  }

  // ---- etapa 1: tipo ----
  function etapaTipo() {
    const el = paraElemento(`
      <div>
        <div class="cartoes-tipo">
          <button class="cartao cartao-tipo ${rascunho.tipo === 'cobranca' ? 'selecionado' : ''}" data-tipo="cobranca">
            <span class="icone">${Icone.alerta}</span><h3>Cobrança</h3><p>Somente clientes com saldo devedor</p>
          </button>
          <button class="cartao cartao-tipo ${rascunho.tipo === 'promocao' ? 'selecionado' : ''}" data-tipo="promocao">
            <span class="icone">${Icone.campanha}</span><h3>Promoção</h3><p>Todos os clientes cadastrados</p>
          </button>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:22px">
          <button class="btn btn--primario" id="btn-avancar" ${rascunho.tipo ? '' : 'disabled'}>Avançar ${Icone.seta}</button>
        </div>
      </div>`);
    el.querySelectorAll('.cartao-tipo').forEach((c) => c.addEventListener('click', () => {
      rascunho.tipo = c.dataset.tipo;
      el.querySelectorAll('.cartao-tipo').forEach((x) => x.classList.remove('selecionado'));
      c.classList.add('selecionado');
      el.querySelector('#btn-avancar').removeAttribute('disabled');
      const template = estado.config.templates.find((t) => (rascunho.tipo === 'cobranca' ? t.id === 1 : t.id === 2));
      if (!rascunho.mensagem && template) rascunho.mensagem = template.texto;
    }));
    el.querySelector('#btn-avancar').addEventListener('click', () => irPara(1));
    return el;
  }

  // ---- etapa 2: mensagem ----
  function etapaMensagem() {
    const clienteExemplo = estado.clientes.find((c) => c.status === 'devedor') ?? estado.clientes[0];
    const el = paraElemento(`
      <div>
        <div class="editor-mensagem">
          <div>
            <label for="texto-mensagem">Mensagem</label>
            <div style="margin-bottom:8px">${PLACEHOLDERS.map((p) => `<button class="chip-placeholder" data-placeholder="${p}">${p}</button>`).join('')}</div>
            <textarea id="texto-mensagem" rows="8">${escaparHtml(rascunho.mensagem)}</textarea>
          </div>
          <div>
            <label>Prévia com dados reais</label>
            <div class="previa-mensagem"><div class="bolha-whats" id="bolha-previa"></div></div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:22px">
          <button class="btn btn--secundario" id="btn-voltar">Voltar</button>
          <button class="btn btn--primario" id="btn-avancar" ${rascunho.mensagem.trim() ? '' : 'disabled'}>Avançar ${Icone.seta}</button>
        </div>
      </div>`);

    const textarea = el.querySelector('#texto-mensagem');
    const bolha = el.querySelector('#bolha-previa');
    const btnAvancar = el.querySelector('#btn-avancar');
    const atualizarPreview = () => {
      rascunho.mensagem = textarea.value;
      const texto = rascunho.mensagem
        .replaceAll('{{nome}}', clienteExemplo.nome.split(' ')[0])
        .replaceAll('{{valor}}', formatarMoeda(clienteExemplo.valorDevido || 89.9));
      bolha.innerHTML = `${escaparHtml(texto)}<time>09:41</time>`;
      btnAvancar.toggleAttribute('disabled', !rascunho.mensagem.trim());
    };
    atualizarPreview();
    textarea.addEventListener('input', atualizarPreview);
    el.querySelectorAll('.chip-placeholder').forEach((chip) => chip.addEventListener('click', () => {
      const pos = textarea.selectionStart ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, pos) + chip.dataset.placeholder + textarea.value.slice(pos);
      textarea.focus();
      atualizarPreview();
    }));
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(0));
    btnAvancar.addEventListener('click', () => {
      rascunho.destinatarios = (rascunho.tipo === 'cobranca'
        ? estado.clientes.filter((c) => c.status === 'devedor')
        : estado.clientes.filter((c) => c.status !== 'sem_telefone')
      ).map((c) => ({ ...c, incluido: true }));
      irPara(2);
    });
    return el;
  }

  // ---- etapa 3: revisão ----
  function etapaRevisao() {
    const el = paraElemento(`
      <div>
        <p style="margin-bottom:14px;font-size:14.5px"><strong id="contador-revisao"></strong> clientes vão receber esta mensagem. Desmarque quem deseja excluir.</p>
        <div class="lista-revisao" id="lista-revisao"></div>
        <div style="display:flex;justify-content:space-between;margin-top:22px">
          <button class="btn btn--secundario" id="btn-voltar">Voltar</button>
          <button class="btn btn--primario" id="btn-avancar">Avançar ${Icone.seta}</button>
        </div>
      </div>`);
    const lista = el.querySelector('#lista-revisao');
    const contador = el.querySelector('#contador-revisao');
    const atualizarContador = () => { contador.textContent = rascunho.destinatarios.filter((d) => d.incluido).length; };
    lista.innerHTML = rascunho.destinatarios.map((c, i) => `
      <label class="linha-revisao">
        <input type="checkbox" data-idx="${i}" ${c.incluido ? 'checked' : ''}>
        <span>${c.nome}</span>
        <span style="margin-left:auto;color:var(--vv-texto-sutil)">${formatarTelefone(c.telefone)}</span>
      </label>`).join('');
    atualizarContador();
    lista.addEventListener('change', (e) => {
      const idx = e.target.dataset.idx;
      if (idx === undefined) return;
      rascunho.destinatarios[idx].incluido = e.target.checked;
      atualizarContador();
    });
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(1));
    el.querySelector('#btn-avancar').addEventListener('click', () => irPara(3));
    return el;
  }

  // ---- etapa 4: confirmação ----
  function etapaConfirmacao() {
    const qtd = rascunho.destinatarios.filter((d) => d.incluido).length;
    const minutos = Math.round((qtd * 8) / 60);
    const el = paraElemento(`
      <div>
        <div class="cartao" style="padding:24px;max-width:480px">
          <h3 style="margin-bottom:14px">Pronto para disparar</h3>
          <p style="font-size:14.5px;margin-bottom:16px">≈ <strong>${qtd} clientes</strong> · tempo estimado de envio: <strong>${minutos} min</strong></p>
          <div class="aviso-caixa">${Icone.aviso}<span>O envio é feito um a um, com intervalo de ${estado.config.intervaloMin}–${estado.config.intervaloMax}s entre mensagens, para evitar bloqueio do número. Não feche esta aba durante o disparo.</span></div>
          <div style="display:flex;justify-content:space-between;margin-top:22px">
            <button class="btn btn--secundario" id="btn-voltar">Voltar</button>
            <button class="btn btn--primario" id="btn-disparar">${Icone.play} Disparar campanha</button>
          </div>
        </div>
      </div>`);
    el.querySelector('#btn-voltar').addEventListener('click', () => irPara(2));
    el.querySelector('#btn-disparar').addEventListener('click', () => {
      estado.campanhaEmAndamento = {
        tipo: rascunho.tipo,
        mensagem: rascunho.mensagem,
        destinatarios: rascunho.destinatarios.filter((d) => d.incluido),
      };
      navegar('envio');
    });
    return el;
  }

  renderizarTrilha();
  renderizarEtapa();
}
