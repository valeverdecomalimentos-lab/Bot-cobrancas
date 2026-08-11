import { estado, aplicarBootstrap, formatarMoeda } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function emBaixoEstoque(produto) {
  if (!Number.isFinite(Number(produto.estoque))) return false;
  if (Number.isFinite(Number(produto.estoqueMinimo))) return Number(produto.estoque) <= Number(produto.estoqueMinimo);
  return /abaixo|baixo|zerado/i.test(String(produto.situacaoEstoque || ''));
}

function quantidade(valor) {
  return Number.isFinite(Number(valor)) ? Number(valor).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '--';
}

export function montarProdutos(alvo) {
  let busca = '';
  let sincronizando = false;
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Produtos</h1><p class="legenda" id="legenda-produtos"></p></div>
        <button class="btn btn--primario" id="btn-sincronizar">${Icone.atualizar} Sincronizar listas</button>
      </div>
      <div class="barra-ferramentas">
        <div class="resumo-estoque" id="resumo-estoque"></div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por codigo, produto ou categoria" id="campo-busca-produto"></div>
      </div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes tabela-produtos">
          <thead><tr><th>Codigo</th><th>Produto</th><th>Categoria</th><th>Venda</th><th>Estoque</th><th>Status</th></tr></thead>
          <tbody id="corpo-produtos"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);
  const legenda = tela.querySelector('#legenda-produtos');
  const resumo = tela.querySelector('#resumo-estoque');
  const corpo = tela.querySelector('#corpo-produtos');
  const botao = tela.querySelector('#btn-sincronizar');

  function renderizar() {
    const produtos = estado.produtos || [];
    const baixoEstoque = produtos.filter(emBaixoEstoque);
    const termo = busca.trim().toLowerCase();
    const filtrados = produtos.filter((produto) => [produto.codigo, produto.nome, produto.categoria].join(' ').toLowerCase().includes(termo));
    const ultima = estado.importacoes.find((item) => item.tipo === 'produtos' && item.status === 'concluida');
    legenda.textContent = `${produtos.length} produtos persistidos${ultima ? `; ultima leitura: ${ultima.arquivo}` : ''}.`;
    resumo.innerHTML = `<span class="badge badge--neutro">${produtos.length} produtos</span><span class="badge ${baixoEstoque.length ? 'badge--alerta' : 'badge--sucesso'}">${baixoEstoque.length} em baixo estoque</span>`;
    botao.disabled = sincronizando;
    botao.innerHTML = `${Icone.atualizar} ${sincronizando ? 'Sincronizando...' : 'Sincronizar listas'}`;
    if (!filtrados.length) {
      corpo.innerHTML = `<tr><td colspan="6"><div class="estado-vazio">${Icone.produtos}<p>Nenhum produto encontrado nas listas importadas.</p></div></td></tr>`;
      return;
    }
    corpo.innerHTML = filtrados.map((produto) => {
      const baixo = emBaixoEstoque(produto);
      return `<tr>
        <td>${escaparHtml(produto.codigo || '--')}</td>
        <td class="celula-nome">${escaparHtml(produto.nome || 'Sem nome')}</td>
        <td>${escaparHtml(produto.categoria || '--')}</td>
        <td class="celula-valor">${produto.precoVenda === null ? '--' : formatarMoeda(produto.precoVenda)}</td>
        <td class="celula-valor">${quantidade(produto.estoque)}${produto.medida ? ` ${escaparHtml(produto.medida)}` : ''}</td>
        <td><span class="badge ${baixo ? 'badge--alerta' : 'badge--sucesso'}">${baixo ? 'Baixo estoque' : 'Regular'}</span></td>
      </tr>`;
    }).join('');
  }

  tela.querySelector('#campo-busca-produto').addEventListener('input', (event) => {
    busca = event.target.value;
    renderizar();
  });
  botao.addEventListener('click', async () => {
    sincronizando = true;
    renderizar();
    try {
      const resultado = await api.syncLists();
      aplicarBootstrap(await api.bootstrap());
      mostrarToast(`${resultado.processados} lista(s) atualizada(s), ${resultado.ignorados} inalterada(s).`, resultado.erros ? 'erro' : 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel sincronizar as listas.', 'erro');
    } finally {
      sincronizando = false;
      if (tela.isConnected) renderizar();
    }
  });
  renderizar();
}
