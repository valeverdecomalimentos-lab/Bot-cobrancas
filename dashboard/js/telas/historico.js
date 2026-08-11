import { estado, formatarData } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function rotuloTipo(tipo) {
  if (tipo === 'cobranca') return ['Cobrança', 'alerta'];
  if (tipo === 'promocao') return ['Promoção', 'sucesso'];
  return ['Arquivo de relatório', 'neutro'];
}

function contagem(valor, alternativa = 0) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, Math.trunc(numero)) : alternativa;
}

export function montarHistorico(alvo) {
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Histórico de campanhas</h1><p class="legenda" id="legenda-historico"></p></div></div>
      <div class="cartao" style="overflow:auto"><table class="tabela-historico" aria-label="Relatórios das campanhas"><thead><tr><th scope="col">Data</th><th scope="col">Tipo</th><th scope="col">Destinatários</th><th scope="col">Taxa de sucesso</th><th scope="col"><span aria-label="Ações">Ações</span></th></tr></thead><tbody id="corpo"></tbody></table></div>
    </div>`);
  alvo.appendChild(tela);
  const corpo = tela.querySelector('#corpo');
  const legenda = tela.querySelector('#legenda-historico');

  function renderizar() {
    const historico = (Array.isArray(estado.historico) ? estado.historico : [])
      .filter((campanha) => campanha && typeof campanha === 'object');
    legenda.textContent = `${historico.length} relatórios persistidos`;
    if (!historico.length) {
      corpo.innerHTML = `<tr><td colspan="5"><div class="estado-vazio" role="status">${Icone.historico}<p>Nenhum relatório real foi salvo ainda.</p></div></td></tr>`;
      return;
    }
    corpo.innerHTML = historico.map((campanha) => {
      const [tipo, tom] = rotuloTipo(campanha.tipo);
      const total = Number(campanha.total);
      const enviados = Number(campanha.enviados);
      const percentual = Number.isFinite(total) && total > 0 && Number.isFinite(enviados)
        ? Math.min(100, Math.max(0, Math.round((enviados / total) * 100)))
        : null;
      const taxa = percentual === null ? '--' : `${percentual}%`;
      const dataFormatada = formatarData(campanha.data);
      const id = String(campanha.id ?? '').trim();
      const acao = id
        ? `<button class="link-tabela" type="button" data-id="${escaparHtml(id)}" aria-label="Ver detalhes da campanha de ${escaparHtml(dataFormatada)}">Ver detalhes</button>`
        : '<span class="legenda">Indisponível</span>';
      return `<tr><td>${escaparHtml(dataFormatada)}</td><td><span class="badge badge--${tom}">${tipo}</span></td><td>${Number.isFinite(total) ? contagem(total) : '--'}</td><td>${taxa}</td><td>${acao}</td></tr>`;
    }).join('');
  }

  renderizar();
  corpo.addEventListener('click', async (event) => {
    const botao = event.target instanceof Element ? event.target.closest('[data-id]') : null;
    if (!botao) return;
    try {
      botao.disabled = true;
      botao.setAttribute('aria-busy', 'true');
      botao.textContent = 'Abrindo...';
      const detalhe = await api.getReport(botao.dataset.id);
      if (!detalhe) throw new Error('Relatório não encontrado.');
      abrirDetalhe(detalhe);
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível abrir o relatório.', 'erro');
    } finally {
      if (botao.isConnected) {
        botao.disabled = false;
        botao.removeAttribute('aria-busy');
        botao.textContent = 'Ver detalhes';
      }
    }
  });
}

function abrirDetalhe(campanha) {
  const arquivos = (Array.isArray(campanha.arquivosDetalhe) ? campanha.arquivosDetalhe : [])
    .filter((arquivo) => arquivo && typeof arquivo === 'object');
  const dataFormatada = formatarData(campanha.data);
  const total = Number(campanha.total);
  const { elemento, fechar } = abrirModal({
    titulo: `Relatório de ${dataFormatada}`,
    corpoHtml: `
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap"><div class="badge badge--sucesso">${contagem(campanha.enviados)} enviados</div><div class="badge badge--erro">${contagem(campanha.erros)} erros</div><div class="badge badge--neutro">${contagem(campanha.ignorados)} ignorados</div></div>
      <p style="font-size:13.5px;color:var(--vv-texto-sutil);margin-bottom:14px">Total processado: ${Number.isFinite(total) ? contagem(total) : '--'}</p>
      ${arquivos.length ? `<div class="lista-revisao">${arquivos.map((arquivo) => `<div class="linha-revisao"><span>${escaparHtml(arquivo.nome || 'Arquivo sem nome')}</span><span style="margin-left:auto;color:var(--vv-texto-sutil)">${arquivo.indisponivel ? 'Indisponível' : arquivo.binario ? 'Arquivo XLSX' : 'Disponível'}</span></div>`).join('')}</div>` : '<p style="font-size:13px;color:var(--vv-texto-sutil)">Nenhum arquivo associado foi encontrado.</p>'}`,
    rodapeHtml: '<button class="btn btn--secundario" type="button" data-cancelar>Fechar</button><button class="btn btn--primario" type="button" data-pasta>Abrir pasta</button>',
  });
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);
  const botaoPasta = elemento.querySelector('[data-pasta]');
  botaoPasta.addEventListener('click', async () => {
    try {
      botaoPasta.disabled = true;
      botaoPasta.setAttribute('aria-busy', 'true');
      botaoPasta.textContent = 'Abrindo...';
      await api.showReportInFolder(campanha.id);
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível localizar o arquivo.', 'erro');
    } finally {
      if (botaoPasta.isConnected) {
        botaoPasta.disabled = false;
        botaoPasta.removeAttribute('aria-busy');
        botaoPasta.textContent = 'Abrir pasta';
      }
    }
  });
}
