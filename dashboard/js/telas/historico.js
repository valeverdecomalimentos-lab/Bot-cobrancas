import { estado, formatarData } from '../nucleo/estado.js';
import { paraElemento, abrirModal, mostrarToast } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

export function montarHistorico(alvo) {
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Histórico de campanhas</h1><p class="legenda">${estado.historico.length} campanhas disparadas</p></div></div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-historico">
          <thead><tr><th>Data</th><th>Tipo</th><th>Destinatários</th><th>Taxa de sucesso</th><th></th></tr></thead>
          <tbody id="corpo"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const corpo = tela.querySelector('#corpo');
  corpo.innerHTML = estado.historico.map((c) => {
    const taxa = ((c.enviados / c.total) * 100).toFixed(0);
    return `<tr>
      <td>${formatarData(c.data)}</td>
      <td><span class="badge badge--${c.tipo === 'cobranca' ? 'alerta' : 'sucesso'}">${c.tipo === 'cobranca' ? 'Cobrança' : 'Promoção'}</span></td>
      <td>${c.total}</td>
      <td>${taxa}%</td>
      <td><button class="link-tabela" data-id="${c.id}">Ver detalhe</button></td>
    </tr>`;
  }).join('');

  corpo.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-id]');
    if (!botao) return;
    abrirDetalhe(estado.historico.find((c) => String(c.id) === botao.dataset.id));
  });
}

function abrirDetalhe(campanha) {
  const { fechar } = abrirModal({
    titulo: `Campanha de ${formatarData(campanha.data)}`,
    corpoHtml: `
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <div class="badge badge--sucesso">${campanha.enviados} enviados</div>
        <div class="badge badge--erro">${campanha.erros} erros</div>
        <div class="badge badge--neutro">${campanha.ignorados} ignorados</div>
      </div>
      <p style="font-size:13.5px;color:var(--vv-texto-sutil)">Tipo: ${campanha.tipo === 'cobranca' ? 'Cobrança' : 'Promoção'} · Total de destinatários: ${campanha.total}</p>
    `,
    rodapeHtml: `<button class="btn btn--secundario" data-cancelar>Fechar</button><button class="btn btn--primario" id="btn-exportar">${Icone.baixar} Exportar CSV</button>`,
  });
  document.getElementById('btn-exportar').addEventListener('click', () => { mostrarToast('Relatório exportado', 'sucesso'); });
  document.querySelector('[data-cancelar]')?.addEventListener('click', fechar);
}
