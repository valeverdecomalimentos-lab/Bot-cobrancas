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

function precoFormatado(valor) {
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor))) return '--';
  return formatarMoeda(Number(valor));
}

export function montarProdutos(alvo) {
  let busca = '';
  let sincronizando = false;
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Produtos</h1><p class="legenda" id="legenda-produtos"></p></div>
        <button class="btn btn--primario" id="btn-sincronizar" type="button">${Icone.atualizar} Sincronizar listas</button>
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
  const botao = tela.querySelector('#btn-sincronizar');

  function renderizar() {
    const produtos = (Array.isArray(estado.produtos) ? estado.produtos : []).filter((produto) => produto && typeof produto === 'object');
    const baixoEstoque = produtos.filter(emBaixoEstoque);
    const termo = busca.trim().toLowerCase();
    const filtrados = produtos.filter((produto) => [produto.codigo, produto.nome, produto.categoria].join(' ').toLowerCase().includes(termo));
    const ultima = (Array.isArray(estado.importacoes) ? estado.importacoes : [])
      .find((item) => item?.tipo === 'produtos' && item.status === 'concluida');
    legenda.textContent = `${produtos.length} produtos persistidos${ultima?.arquivo ? `; última leitura: ${ultima.arquivo}` : ''}.`;
    resumo.innerHTML = `<span class="badge badge--neutro">${produtos.length} produtos</span><span class="badge ${baixoEstoque.length ? 'badge--alerta' : 'badge--sucesso'}">${baixoEstoque.length} em baixo estoque</span>`;
    botao.disabled = sincronizando;
    botao.setAttribute('aria-busy', sincronizando ? 'true' : 'false');
    botao.setAttribute('aria-label', sincronizando ? 'Sincronizando listas de produtos' : 'Sincronizar listas de produtos');
    botao.innerHTML = `${Icone.atualizar} ${sincronizando ? 'Sincronizando...' : 'Sincronizar listas'}`;
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
