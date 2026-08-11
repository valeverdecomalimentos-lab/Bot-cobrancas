import { estado, formatarData } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function rotuloTipo(tipo) {
  if (tipo === 'cobranca') return ['Cobranca', 'alerta'];
  if (tipo === 'promocao') return ['Promocao', 'sucesso'];
  return ['Arquivo de relatorio', 'neutro'];
}

export function montarHistorico(alvo) {
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Historico de campanhas</h1><p class="legenda" id="legenda-historico"></p></div></div>
      <div class="cartao" style="overflow:auto"><table class="tabela-historico"><thead><tr><th>Data</th><th>Tipo</th><th>Destinatarios</th><th>Taxa de sucesso</th><th></th></tr></thead><tbody id="corpo"></tbody></table></div>
    </div>`);
  alvo.appendChild(tela);
  const corpo = tela.querySelector('#corpo');
  const legenda = tela.querySelector('#legenda-historico');

  function renderizar() {
    legenda.textContent = `${estado.historico.length} relatorios persistidos`;
    if (!estado.historico.length) {
      corpo.innerHTML = `<tr><td colspan="5"><div class="estado-vazio">${Icone.historico}<p>Nenhum relatorio real foi salvo ainda.</p></div></td></tr>`;
      return;
    }
    corpo.innerHTML = estado.historico.map((campanha) => {
      const [tipo, tom] = rotuloTipo(campanha.tipo);
      const total = Number(campanha.total);
      const enviados = Number(campanha.enviados);
      const taxa = Number.isFinite(total) && total > 0 ? `${Math.round((enviados / total) * 100)}%` : '--';
      return `<tr><td>${formatarData(campanha.data)}</td><td><span class="badge badge--${tom}">${tipo}</span></td><td>${Number.isFinite(total) ? total : '--'}</td><td>${taxa}</td><td><button class="link-tabela" data-id="${escaparHtml(campanha.id)}">Ver detalhe</button></td></tr>`;
    }).join('');
  }

  renderizar();
  corpo.addEventListener('click', async (event) => {
    const botao = event.target.closest('[data-id]');
    if (!botao) return;
    try {
      const detalhe = await api.getReport(botao.dataset.id);
      if (!detalhe) throw new Error('Relatorio nao encontrado.');
      abrirDetalhe(detalhe);
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel abrir o relatorio.', 'erro');
    }
  });
}

function abrirDetalhe(campanha) {
  const arquivos = Array.isArray(campanha.arquivosDetalhe) ? campanha.arquivosDetalhe : [];
  const { elemento, fechar } = abrirModal({
    titulo: `Relatorio de ${formatarData(campanha.data)}`,
    corpoHtml: `
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap"><div class="badge badge--sucesso">${Number(campanha.enviados || 0)} enviados</div><div class="badge badge--erro">${Number(campanha.erros || 0)} erros</div><div class="badge badge--neutro">${Number(campanha.ignorados || 0)} ignorados</div></div>
      <p style="font-size:13.5px;color:var(--vv-texto-sutil);margin-bottom:14px">Total processado: ${campanha.total ?? '--'}</p>
      ${arquivos.length ? `<div class="lista-revisao">${arquivos.map((arquivo) => `<div class="linha-revisao"><span>${escaparHtml(arquivo.nome)}</span><span style="margin-left:auto;color:var(--vv-texto-sutil)">${arquivo.indisponivel ? 'Indisponivel' : arquivo.binario ? 'Arquivo XLSX' : 'Disponivel'}</span></div>`).join('')}</div>` : '<p style="font-size:13px;color:var(--vv-texto-sutil)">Nenhum arquivo associado foi encontrado.</p>'}`,
    rodapeHtml: '<button class="btn btn--secundario" data-cancelar>Fechar</button><button class="btn btn--primario" data-pasta>Abrir pasta</button>',
  });
  elemento.querySelector('[data-cancelar]').addEventListener('click', fechar);
  elemento.querySelector('[data-pasta]').addEventListener('click', async () => {
    try {
      await api.showReportInFolder(campanha.id);
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel localizar o arquivo.', 'erro');
    }
  });
}
