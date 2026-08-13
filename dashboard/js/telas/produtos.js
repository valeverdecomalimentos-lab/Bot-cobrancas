import { estado, formatarMoeda } from '../nucleo/estado.js';
import { paraElemento, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function emBaixoEstoque(produto) {
  if (!Number.isFinite(Number(produto.estoque))) return false;
  if (Number.isFinite(Number(produto.estoqueMinimo))) return Number(produto.estoque) <= Number(produto.estoqueMinimo);
  return /abaixo|baixo|zerado/i.test(String(produto.situacaoEstoque || ''));
}

function quantidade(valor) {
  return Number.isFinite(Number(valor)) ? Number(valor).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '--';
}

function precoFormatado(valor) {
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor))) return '--';
  return formatarMoeda(Number(valor));
}

export function montarProdutos(alvo) {
  let busca = '';
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Produtos</h1><p class="legenda" id="legenda-produtos"></p></div>
      </div>
      <div class="barra-ferramentas">
        <div class="resumo-estoque" id="resumo-estoque" role="status" aria-live="polite"></div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por código, produto ou categoria" id="campo-busca-produto" aria-label="Buscar produtos por código, nome ou categoria" autocomplete="off"></div>
      </div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes tabela-produtos" aria-label="Lista de produtos e estoque">
          <thead><tr><th scope="col">Código</th><th scope="col">Produto</th><th scope="col">Categoria</th><th scope="col">Venda</th><th scope="col">Estoque</th><th scope="col">Status</th></tr></thead>
          <tbody id="corpo-produtos"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);
  const legenda = tela.querySelector('#legenda-produtos');
  const resumo = tela.querySelector('#resumo-estoque');
  const corpo = tela.querySelector('#corpo-produtos');

  function renderizar() {
    const produtos = (Array.isArray(estado.produtos) ? estado.produtos : []).filter((produto) => produto && typeof produto === 'object');
    const baixoEstoque = produtos.filter(emBaixoEstoque);
    const termo = busca.trim().toLowerCase();
    const filtrados = produtos.filter((produto) => [produto.codigo, produto.nome, produto.categoria].join(' ').toLowerCase().includes(termo));
    const ultima = (Array.isArray(estado.importacoes) ? estado.importacoes : [])
      .find((item) => item?.tipo === 'produtos' && item.status === 'concluida');
    legenda.textContent = `${produtos.length} produtos persistidos${ultima?.arquivo ? `; última leitura: ${ultima.arquivo}` : ''}.`;
    resumo.innerHTML = `<span class="badge badge--neutro">${produtos.length} produtos</span><span class="badge ${baixoEstoque.length ? 'badge--alerta' : 'badge--sucesso'}">${baixoEstoque.length} em baixo estoque</span>`;
    if (!filtrados.length) {
      const mensagem = produtos.length
        ? 'Nenhum produto corresponde à busca informada.'
        : 'Nenhum produto foi encontrado nas listas importadas.';
      corpo.innerHTML = `<tr><td colspan="6"><div class="estado-vazio" role="status">${Icone.produtos}<p>${mensagem}</p></div></td></tr>`;
      return;
    }
    corpo.innerHTML = filtrados.map((produto) => {
      const baixo = emBaixoEstoque(produto);
      return `<tr>
        <td>${escaparHtml(produto.codigo || '--')}</td>
        <td class="celula-nome">${escaparHtml(produto.nome || 'Sem nome')}</td>
        <td>${escaparHtml(produto.categoria || '--')}</td>
        <td class="celula-valor">${precoFormatado(produto.precoVenda)}</td>
        <td class="celula-valor">${quantidade(produto.estoque)}${produto.medida ? ` ${escaparHtml(produto.medida)}` : ''}</td>
        <td><span class="badge ${baixo ? 'badge--alerta' : 'badge--sucesso'}">${baixo ? 'Baixo estoque' : 'Regular'}</span></td>
      </tr>`;
    }).join('');
  }

  tela.querySelector('#campo-busca-produto').addEventListener('input', (event) => {
    busca = event.target.value;
    renderizar();
  });
  renderizar();
}
