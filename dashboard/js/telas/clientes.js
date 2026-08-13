import { estado, formatarMoeda, formatarTelefone } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { paraElemento, abrirModal, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const ROTULO_STATUS = {
  em_dia: ['Em dia', 'sucesso'],
  devedor: ['Devedor', 'alerta'],
  sem_telefone: ['Sem telefone', 'neutro'],
};

const ROTULO_PERFIL = {
  critico: ['Cobrança prioritária', 'erro'],
  atencao: ['Cobrança elegível', 'alerta'],
  acompanhamento: ['Acompanhar saldo', 'neutro'],
  contato: ['Atualizar contato', 'alerta'],
  regular: ['Cliente regular', 'sucesso'],
};

function valorDevido(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

function numeroSeguro(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function inteiroNaoNegativo(valor) {
  return Math.max(0, Math.trunc(numeroSeguro(valor)));
}

function formatarCentavos(valor) {
  return formatarMoeda(numeroSeguro(valor) / 100);
}

function formatarDataConsumer(valor) {
  const instante = Date.parse(String(valor || ''));
  if (!Number.isFinite(instante)) return 'Não informado';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(instante).replace(',', ' às');
}

function formatarIntervaloDias(valor) {
  if (valor === null || valor === undefined || valor === '') return 'Ainda não calculável';
  const dias = numeroSeguro(valor);
  const texto = dias.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return `${texto} ${Math.abs(dias) === 1 ? 'dia' : 'dias'}`;
}

function formatarQuantidadeMilli(valor) {
  return (numeroSeguro(valor) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

const ROTULO_CANAL_CONSUMER = {
  delivery: 'Entrega',
  pickup: 'Retirada',
  inStore: 'Compra na loja',
  other: 'Outro canal',
  unknown: 'Desconhecido',
};

function canaisConsumer(perfil) {
  const preenchimento = perfil?.fulfillment && typeof perfil.fulfillment === 'object'
    ? perfil.fulfillment
    : {};
  const explicitos = ['delivery', 'pickup', 'inStore', 'other'].map((chave) => ({
    chave,
    rotulo: ROTULO_CANAL_CONSUMER[chave],
    quantidade: inteiroNaoNegativo(preenchimento[chave]),
  }));
  const totalExplicito = explicitos.reduce((total, canal) => total + canal.quantidade, 0);
  const quantidadeDesconhecida = Object.hasOwn(preenchimento, 'unknown')
    ? inteiroNaoNegativo(preenchimento.unknown)
    : Math.max(0, inteiroNaoNegativo(perfil?.orderCount) - totalExplicito);
  return [
    ...explicitos,
    { chave: 'unknown', rotulo: ROTULO_CANAL_CONSUMER.unknown, quantidade: quantidadeDesconhecida },
  ];
}

function categoriasFavoritas(perfil) {
  const categoriasInformadas = Array.isArray(perfil?.favoriteCategories)
    ? perfil.favoriteCategories
    : [];
  if (categoriasInformadas.length) {
    return categoriasInformadas
      .filter((categoria) => categoria && typeof categoria === 'object')
      .map((categoria) => ({
        nome: String(categoria.category || categoria.name || 'Sem categoria').trim() || 'Sem categoria',
        totalCents: numeroSeguro(categoria.totalCents),
        quantityMilli: numeroSeguro(categoria.quantityMilli),
      }))
      .sort((a, b) => b.totalCents - a.totalCents || b.quantityMilli - a.quantityMilli)
      .slice(0, 5);
  }

  const agregadas = new Map();
  for (const produto of Array.isArray(perfil?.favoriteProducts) ? perfil.favoriteProducts : []) {
    if (!produto || typeof produto !== 'object') continue;
    const nome = String(produto.category || 'Sem categoria').trim() || 'Sem categoria';
    const atual = agregadas.get(nome) || { nome, totalCents: 0, quantityMilli: 0 };
    atual.totalCents += numeroSeguro(produto.totalCents);
    atual.quantityMilli += numeroSeguro(produto.quantityMilli);
    agregadas.set(nome, atual);
  }
  return [...agregadas.values()]
    .sort((a, b) => b.totalCents - a.totalCents || b.quantityMilli - a.quantityMilli || a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, 5);
}

function ordenarMaisRecentes(lista, campoData) {
  return (Array.isArray(lista) ? lista : [])
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((a, b) => {
      const dataA = Date.parse(String(a[campoData] || ''));
      const dataB = Date.parse(String(b[campoData] || ''));
      if (Number.isFinite(dataA) && Number.isFinite(dataB)) return dataB - dataA;
      if (Number.isFinite(dataA)) return -1;
      if (Number.isFinite(dataB)) return 1;
      return 0;
    });
}

function rotuloPagamentoCompra(compra) {
  if (compra?.cancelled || compra?.paymentStatus === 'cancelled') return ['Compra cancelada', 'neutro'];
  const status = String(compra?.paymentStatus || '').toLowerCase();
  if (compra?.partialPayment || status === 'partial') return ['Pagamento parcial', 'alerta'];
  if (status === 'paid') return ['Pago', 'sucesso'];
  if (status === 'overpaid') return ['Pago acima do total', 'sucesso'];
  return ['Sem pagamento registrado', 'erro'];
}

function rotuloMovimentacaoFiado(tipo) {
  return ({
    charge: 'Compra lançada no fiado',
    payment: 'Pagamento do fiado',
    adjustment: 'Ajuste de saldo',
  })[String(tipo || '').toLowerCase()] || 'Movimentação do fiado';
}

function avisoHistoricoTruncado(meta) {
  if (!meta?.truncated?.any) return '';
  const rotulos = {
    orders: 'compras',
    payments: 'pagamentos',
    ledger: 'movimentações do fiado',
    items: 'itens de compras',
    deliveries: 'entregas',
  };
  const partes = Object.entries(rotulos)
    .filter(([chave]) => Boolean(meta.truncated[chave]))
    .map(([, rotulo]) => rotulo);
  const complemento = partes.length ? ` em ${partes.join(', ')}` : '';
  return `<p class="perfil-consumer__historico-aviso" role="note"><strong>Visualização parcial.</strong> O limite de segurança foi atingido${escaparHtml(complemento)}. Os registros exibidos continuam ordenados do mais recente para o mais antigo.</p>`;
}

function renderizarItensCompra(compra) {
  const itens = (Array.isArray(compra?.items) ? compra.items : [])
    .filter((item) => item && typeof item === 'object');
  if (!itens.length) {
    return '<p class="perfil-consumer__vazio">Nenhum item detalhado foi encontrado nesta compra.</p>';
  }
  return `<ul class="perfil-consumer__itens" aria-label="Itens desta compra">${itens.map((item) => `
    <li>
      <div>
        <strong>${escaparHtml(item.productName || 'Produto sem nome')}</strong>
        <span>${escaparHtml(item.category || 'Sem categoria')}${item.cancelled ? ' · Item cancelado' : ''}</span>
      </div>
      <span>${formatarQuantidadeMilli(item.quantityMilli)} × ${formatarCentavos(item.unitPriceCents)}</span>
      <strong>${formatarCentavos(item.totalCents)}</strong>
    </li>`).join('')}</ul>`;
}

function renderizarHistoricoCompras(perfil, idBase) {
  const compras = ordenarMaisRecentes(perfil?.ordersHistory, 'orderedAt');
  if (!compras.length) return '<p class="perfil-consumer__vazio">Nenhuma compra detalhada foi encontrada.</p>';
  return `<ol class="perfil-consumer__historico-lista" aria-label="Compras da mais recente para a mais antiga">${compras.map((compra, indice) => {
    const [rotuloPagamento, tomPagamento] = rotuloPagamentoCompra(compra);
    const dataValida = Number.isFinite(Date.parse(String(compra.orderedAt || '')))
      ? String(compra.orderedAt)
      : '';
    return `<li>
      <details class="perfil-consumer__compra" ${indice === 0 ? 'open' : ''}>
        <summary>
          <span>
            <strong>Compra em <time${dataValida ? ` datetime="${escaparHtml(dataValida)}"` : ''}>${escaparHtml(formatarDataConsumer(compra.orderedAt))}</time></strong>
            <span class="badge badge--${tomPagamento}">${rotuloPagamento}</span>
          </span>
          <strong>${formatarCentavos(compra.totalCents)}</strong>
        </summary>
        <dl class="perfil-consumer__compra-metricas">
          <div><dt>Total da compra</dt><dd>${formatarCentavos(compra.totalCents)}</dd></div>
          <div><dt>Pago registrado</dt><dd>${formatarCentavos(compra.recordedPaidTotalCents)}</dd></div>
          <div><dt>Restante registrado</dt><dd>${formatarCentavos(compra.recordedRemainingCents)}</dd></div>
          <div><dt>Origem</dt><dd>${escaparHtml(compra.origin || 'Não informada')}</dd></div>
        </dl>
        <div class="perfil-consumer__subtitulo"><strong>Produtos e quantidades</strong></div>
        ${renderizarItensCompra(compra)}
        ${compra?.historyTruncated && Object.values(compra.historyTruncated).some(Boolean)
          ? '<p class="perfil-consumer__historico-aviso" role="note">Há mais detalhes nesta compra do que o limite exibido.</p>'
          : ''}
      </details>
    </li>`;
  }).join('')}</ol>`;
}

function renderizarHistoricoPagamentos(perfil) {
  const pagamentos = ordenarMaisRecentes(perfil?.paymentsHistory, 'paidAt');
  if (!pagamentos.length) return '<p class="perfil-consumer__vazio">Nenhum pagamento detalhado foi encontrado.</p>';
  return `<ol class="perfil-consumer__movimentacoes" aria-label="Pagamentos do mais recente para o mais antigo">${pagamentos.map((pagamento) => `
    <li>
      <div>
        <strong>${escaparHtml(formatarDataConsumer(pagamento.paidAt))}</strong>
        <span>${escaparHtml(pagamento.method || 'Forma não informada')} · ${pagamento.orderExternalId ? 'Vinculado a uma compra' : 'Sem pedido vinculado'}${pagamento.cancelled ? ' · Cancelado' : ''}</span>
      </div>
      <strong>${formatarCentavos(pagamento.amountCents)}</strong>
    </li>`).join('')}</ol>`;
}

function renderizarHistoricoFiado(perfil) {
  const movimentacoes = ordenarMaisRecentes(perfil?.ledgerHistory, 'occurredAt');
  if (!movimentacoes.length) return '<p class="perfil-consumer__vazio">Nenhuma movimentação do fiado foi encontrada.</p>';
  return `<ol class="perfil-consumer__movimentacoes" aria-label="Movimentações do fiado da mais recente para a mais antiga">${movimentacoes.map((movimentacao) => `
    <li>
      <div>
        <strong>${escaparHtml(rotuloMovimentacaoFiado(movimentacao.kind))}</strong>
        <span>${escaparHtml(formatarDataConsumer(movimentacao.occurredAt))}${movimentacao.description ? ` · ${escaparHtml(movimentacao.description)}` : ''}${movimentacao.cancelled ? ' · Cancelada' : ''}</span>
        ${movimentacao.balanceCents === null || movimentacao.balanceCents === undefined ? '' : `<small>Saldo após a movimentação: ${formatarCentavos(movimentacao.balanceCents)}</small>`}
      </div>
      <strong>${formatarCentavos(movimentacao.amountCents)}</strong>
    </li>`).join('')}</ol>`;
}

function renderizarHistoricoCompleto(perfil, idBase) {
  return `
    ${avisoHistoricoTruncado(perfil?.historyMeta)}
    <section class="perfil-consumer__historico-secao" aria-labelledby="${idBase}-historico-compras">
      <div class="perfil-consumer__titulo-secao"><div><h6 id="${idBase}-historico-compras">Histórico de compras</h6><p>Da compra mais recente para a mais antiga, com produtos e valores registrados.</p></div></div>
      ${renderizarHistoricoCompras(perfil, idBase)}
    </section>
    <div class="perfil-consumer__duas-colunas perfil-consumer__historico-colunas">
      <section class="perfil-consumer__historico-secao" aria-labelledby="${idBase}-historico-pagamentos">
        <div class="perfil-consumer__titulo-secao"><div><h6 id="${idBase}-historico-pagamentos">Histórico de pagamentos</h6><p>Inclui pagamentos sem pedido vinculado.</p></div></div>
        ${renderizarHistoricoPagamentos(perfil)}
      </section>
      <section class="perfil-consumer__historico-secao" aria-labelledby="${idBase}-historico-fiado">
        <div class="perfil-consumer__titulo-secao"><div><h6 id="${idBase}-historico-fiado">Movimentações do fiado</h6><p>Lançamentos, pagamentos e ajustes de saldo.</p></div></div>
        ${renderizarHistoricoFiado(perfil)}
      </section>
    </div>`;
}

async function carregarHistoricoCompleto(cliente, container, idBase) {
  try {
    const sourceKey = String(cliente?.consumerSourceKey || cliente?.vinculoConsumer?.sourceKey || '').trim();
    const externalId = String(cliente?.consumerExternalId || cliente?.vinculoConsumer?.externalId || '').trim();
    if (!sourceKey || !externalId) throw new Error('Vínculo Consumer indisponível.');
    const resultado = await api.getConsumerCustomerProfile(sourceKey, externalId);
    const perfil = resultado?.perfil && typeof resultado.perfil === 'object' ? resultado.perfil : resultado;
    if (!perfil || typeof perfil !== 'object') throw new Error('Perfil detalhado não encontrado.');
    if (!container.isConnected) return;
    container.removeAttribute('role');
    container.innerHTML = renderizarHistoricoCompleto(perfil, idBase);
  } catch {
    if (!container.isConnected) return;
    container.setAttribute('role', 'alert');
    container.innerHTML = '<div class="perfil-consumer__historico-erro"><strong>Não foi possível carregar o histórico completo.</strong><span>O resumo acima continua disponível. Tente abrir o perfil novamente.</span></div>';
  }
}

function abrirModalPerfilConsumer(cliente) {
  const perfil = cliente?.perfilConsumer;
  if (!perfil || typeof perfil !== 'object') return;

  const nomeCliente = String(cliente.nome || perfil.name || 'Cliente').trim() || 'Cliente';
  const produtos = (Array.isArray(perfil.favoriteProducts) ? perfil.favoriteProducts : [])
    .filter((produto) => produto && typeof produto === 'object')
    .slice(0, 5);
  const categorias = categoriasFavoritas(perfil);
  const canais = canaisConsumer(perfil);
  const formaPreferida = Array.isArray(perfil.paymentMethods)
    ? String(perfil.paymentMethods.find((forma) => forma?.method)?.method || '').trim()
    : '';
  const formasPagamento = (Array.isArray(perfil.paymentMethods) ? perfil.paymentMethods : [])
    .filter((forma) => forma && typeof forma === 'object')
    .slice(0, 5);
  const canalPreferido = ROTULO_CANAL_CONSUMER[perfil.preferredFulfillment] || 'Não identificado';
  const telefoneCliente = formatarTelefone(cliente.telefone || cliente.telefoneOriginal || '');
  const idBase = `perfil-consumer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const { elemento, fechar } = abrirModal({
    titulo: 'Perfil de compras',
    corpoHtml: `
      <article class="perfil-consumer">
        <header class="perfil-consumer__intro">
          <span class="perfil-consumer__icone" aria-hidden="true">${Icone.clientes}</span>
          <div>
            <span class="perfil-consumer__origem">Histórico do Consumer</span>
            <h4>${escaparHtml(nomeCliente)}</h4>
            <p>${telefoneCliente ? `Telefone: ${escaparHtml(telefoneCliente)} · ` : ''}Indicadores calculados a partir das compras e dos pagamentos importados.</p>
          </div>
        </header>

        <section class="perfil-consumer__bloco" aria-labelledby="${idBase}-compras">
          <div class="perfil-consumer__titulo-secao">
            <h5 id="${idBase}-compras">Compras e frequência</h5>
          </div>
          <dl class="perfil-consumer__metricas">
            <div><dt>Compras</dt><dd>${inteiroNaoNegativo(perfil.orderCount).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Gasto total</dt><dd>${formatarCentavos(perfil.totalPurchasedCents)}</dd></div>
            <div><dt>Ticket médio</dt><dd>${formatarCentavos(perfil.averageTicketCents)}</dd></div>
            <div><dt>Média entre compras</dt><dd>${escaparHtml(formatarIntervaloDias(perfil.averageDaysBetweenPurchases))}</dd></div>
            <div><dt>Produtos distintos</dt><dd>${inteiroNaoNegativo(perfil.distinctProducts).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Categorias distintas</dt><dd>${inteiroNaoNegativo(perfil.distinctCategories).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Primeira compra</dt><dd>${escaparHtml(formatarDataConsumer(perfil.firstPurchaseAt))}</dd></div>
            <div><dt>Última compra</dt><dd>${escaparHtml(formatarDataConsumer(perfil.lastPurchaseAt))}</dd></div>
          </dl>
        </section>

        <section class="perfil-consumer__bloco" aria-labelledby="${idBase}-pagamentos">
          <div class="perfil-consumer__titulo-secao">
            <h5 id="${idBase}-pagamentos">Pagamentos e saldo</h5>
            <span class="badge ${numeroSeguro(perfil.currentDebtCents) > 0 ? 'badge--alerta' : 'badge--sucesso'}">${numeroSeguro(perfil.currentDebtCents) > 0 ? 'Com saldo aberto' : 'Sem saldo aberto'}</span>
          </div>
          <dl class="perfil-consumer__metricas perfil-consumer__metricas--pagamentos">
            <div><dt>Pagamentos</dt><dd>${inteiroNaoNegativo(perfil.paymentCount).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Compras com pagamento parcial</dt><dd>${inteiroNaoNegativo(perfil.partialPaymentOrderCount).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Total pago</dt><dd>${formatarCentavos(perfil.paidTotalCents)}</dd></div>
            <div><dt>Saldo em aberto</dt><dd class="${numeroSeguro(perfil.currentDebtCents) > 0 ? 'perfil-consumer__valor-alerta' : ''}">${formatarCentavos(perfil.currentDebtCents)}</dd></div>
            <div><dt>Forma preferida</dt><dd>${escaparHtml(formaPreferida || 'Não informada')}</dd></div>
            <div><dt>Último pagamento</dt><dd>${escaparHtml(formatarDataConsumer(perfil.lastPaymentAt))}</dd></div>
            <div><dt>Último pagamento parcial</dt><dd>${escaparHtml(formatarDataConsumer(perfil.lastPartialPaymentAt))}</dd></div>
            <div><dt>Média entre pagamentos</dt><dd>${escaparHtml(formatarIntervaloDias(perfil.averageDaysBetweenPayments))}</dd></div>
            <div><dt>Pagamentos do fiado</dt><dd>${inteiroNaoNegativo(perfil.debtPaymentCount).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Total pago no fiado</dt><dd>${formatarCentavos(perfil.debtPaidTotalCents)}</dd></div>
            <div><dt>Último pagamento do fiado</dt><dd>${escaparHtml(formatarDataConsumer(perfil.lastDebtPaymentAt))}</dd></div>
            <div><dt>Média entre pagamentos do fiado</dt><dd>${escaparHtml(formatarIntervaloDias(perfil.averageDaysBetweenDebtPayments))}</dd></div>
          </dl>
          ${formasPagamento.length ? `<ol class="perfil-consumer__ranking perfil-consumer__ranking--pagamentos" aria-label="Formas de pagamento mais usadas">${formasPagamento.map((forma, indice) => `
            <li><span class="perfil-consumer__posicao" aria-hidden="true">${indice + 1}</span><div><strong>${escaparHtml(forma.method || 'Não informada')}</strong><span>${inteiroNaoNegativo(forma.count).toLocaleString('pt-BR')} pagamento(s)</span></div><small>${formatarCentavos(forma.totalCents)}</small></li>
          `).join('')}</ol>` : ''}
        </section>

        <div class="perfil-consumer__duas-colunas">
          <section class="perfil-consumer__bloco" aria-labelledby="${idBase}-produtos">
            <div class="perfil-consumer__titulo-secao"><h5 id="${idBase}-produtos">Produtos favoritos</h5></div>
            ${produtos.length ? `<ol class="perfil-consumer__ranking">${produtos.map((produto, indice) => `
              <li>
                <span class="perfil-consumer__posicao" aria-hidden="true">${indice + 1}</span>
                <div><strong>${escaparHtml(produto.name || 'Produto sem nome')}</strong><span>${escaparHtml(produto.category || 'Sem categoria')}</span></div>
                <small>${formatarQuantidadeMilli(produto.quantityMilli)} em quantidade · ${formatarCentavos(produto.totalCents)}</small>
              </li>`).join('')}</ol>` : '<p class="perfil-consumer__vazio">Nenhum produto identificado nas compras.</p>'}
          </section>

          <section class="perfil-consumer__bloco" aria-labelledby="${idBase}-categorias">
            <div class="perfil-consumer__titulo-secao"><h5 id="${idBase}-categorias">Categorias favoritas</h5></div>
            ${categorias.length ? `<ol class="perfil-consumer__ranking">${categorias.map((categoria, indice) => `
              <li>
                <span class="perfil-consumer__posicao" aria-hidden="true">${indice + 1}</span>
                <div><strong>${escaparHtml(categoria.nome)}</strong><span>${formatarQuantidadeMilli(categoria.quantityMilli)} em quantidade</span></div>
                <small>${formatarCentavos(categoria.totalCents)}</small>
              </li>`).join('')}</ol>` : '<p class="perfil-consumer__vazio">Nenhuma categoria identificada nas compras.</p>'}
          </section>
        </div>

        <section class="perfil-consumer__bloco" aria-labelledby="${idBase}-canais">
          <div class="perfil-consumer__titulo-secao">
            <div><h5 id="${idBase}-canais">Canais de compra</h5><p>Compras sem origem explícita permanecem separadas como desconhecidas.</p></div>
            <span class="badge badge--neutro">Mais frequente entre identificados: ${escaparHtml(canalPreferido)}</span>
          </div>
          <ul class="perfil-consumer__canais">${canais.map((canal) => `
            <li class="${canal.chave === 'unknown' ? 'perfil-consumer__canal--desconhecido' : ''}">
              <span>${escaparHtml(canal.rotulo)}</span><strong>${canal.quantidade.toLocaleString('pt-BR')}</strong>
            </li>`).join('')}</ul>
        </section>

        <section class="perfil-consumer__bloco perfil-consumer__historico" aria-labelledby="${idBase}-historico">
          <div class="perfil-consumer__titulo-secao">
            <div><h5 id="${idBase}-historico">Histórico completo</h5><p>Compras, produtos, pagamentos e movimentações são carregados somente ao abrir este perfil.</p></div>
          </div>
          <div class="perfil-consumer__historico-carregando" data-perfil-consumer-detalhes role="status" aria-live="polite">
            <span aria-hidden="true"></span>
            <strong>Carregando histórico completo…</strong>
          </div>
        </section>
      </article>`,
    rodapeHtml: '<button class="btn btn--primario" type="button" data-fechar-perfil>Fechar</button>',
  });
  elemento.querySelector('.modal')?.classList.add('modal--perfil-consumer');
  elemento.querySelector('[data-fechar-perfil]').addEventListener('click', fechar);
  const detalhes = elemento.querySelector('[data-perfil-consumer-detalhes]');
  if (detalhes) carregarHistoricoCompleto(cliente, detalhes, idBase);
}

export function montarClientes(alvo) {
  let filtroStatus = 'todos';
  let termoBusca = '';
  let clientesRenderizados = [];
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Clientes</h1><p class="legenda" id="legenda-clientes"></p></div>
      </div>
      <div class="barra-ferramentas">
        <div class="grupo-filtros" id="grupo-filtros" role="group" aria-label="Filtrar clientes por status">
          <button class="chip-filtro ativo" type="button" data-status="todos" aria-pressed="true">Todos</button>
          <button class="chip-filtro" type="button" data-status="devedor" aria-pressed="false">Devedores</button>
          <button class="chip-filtro" type="button" data-status="em_dia" aria-pressed="false">Em dia</button>
          <button class="chip-filtro" type="button" data-status="sem_telefone" aria-pressed="false">Sem telefone</button>
        </div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por nome, CPF ou telefone" id="campo-busca" aria-label="Buscar clientes por nome, CPF ou telefone" autocomplete="off"></div>
      </div>
      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes" aria-label="Lista de clientes">
          <thead><tr><th scope="col">Nome</th><th scope="col">Telefone</th><th scope="col">Valor devido</th><th scope="col">Status</th><th scope="col">Perfil</th></tr></thead>
          <tbody id="corpo-tabela"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const corpoTabela = tela.querySelector('#corpo-tabela');
  const legenda = tela.querySelector('#legenda-clientes');

  function renderizarLinhas() {
    const busca = termoBusca.trim().toLowerCase();
    const clientes = (Array.isArray(estado.clientes) ? estado.clientes : [])
      .filter((cliente) => cliente && typeof cliente === 'object');
    const filtrados = clientes.filter((cliente) => {
      const passaStatus = filtroStatus === 'todos' || cliente.status === filtroStatus;
      const texto = [cliente.nome, cliente.cpf, cliente.telefone].join(' ').toLowerCase();
      return passaStatus && (!busca || texto.includes(busca));
    });
    clientesRenderizados = filtrados;
    legenda.textContent = `${clientes.length} clientes persistidos na base local`;
    if (!filtrados.length) {
      const mensagem = clientes.length
        ? 'Nenhum cliente corresponde aos filtros selecionados.'
        : 'Nenhum cliente foi importado ainda.';
      corpoTabela.innerHTML = `<tr><td colspan="5"><div class="estado-vazio" role="status">${Icone.clientes}<p>${mensagem}</p></div></td></tr>`;
      return;
    }
    corpoTabela.innerHTML = filtrados.map((cliente, indice) => {
      const [rotulo, tom] = ROTULO_STATUS[cliente.status] || ['Sem status', 'neutro'];
      const perfil = cliente.perfilAnalitico || null;
      const [rotuloPerfil, tomPerfil] = perfil ? (ROTULO_PERFIL[perfil.nivel] || [perfil.rotulo, 'neutro']) : ['Perfil indisponível', 'neutro'];
      const possuiPerfilConsumer = cliente.perfilConsumer && typeof cliente.perfilConsumer === 'object';
      return `<tr>
        <td class="celula-nome">${escaparHtml(cliente.nome || 'Sem nome')}</td>
        <td>${escaparHtml(formatarTelefone(cliente.telefone))}</td>
        <td class="celula-valor">${formatarMoeda(valorDevido(cliente))}</td>
        <td><span class="badge badge--${tom}">${rotulo}</span></td>
        <td><div class="celula-perfil"><span class="badge badge--${tomPerfil}" title="${escaparHtml(perfil?.motivo || '')}">${escaparHtml(rotuloPerfil)}</span>${possuiPerfilConsumer ? `<button class="botao-perfil-consumer" type="button" data-perfil-consumer="${indice}" aria-label="Ver perfil de compras de ${escaparHtml(cliente.nome || 'cliente')}">Ver perfil</button>` : ''}</div></td>
      </tr>`;
    }).join('');
  }

  renderizarLinhas();
  tela.querySelector('#grupo-filtros').addEventListener('click', (event) => {
    const botao = event.target instanceof Element ? event.target.closest('.chip-filtro') : null;
    if (!botao) return;
    tela.querySelectorAll('.chip-filtro').forEach((item) => {
      item.classList.remove('ativo');
      item.setAttribute('aria-pressed', 'false');
    });
    botao.classList.add('ativo');
    botao.setAttribute('aria-pressed', 'true');
    filtroStatus = botao.dataset.status;
    renderizarLinhas();
  });
  tela.querySelector('#campo-busca').addEventListener('input', (event) => {
    termoBusca = event.target.value;
    renderizarLinhas();
  });
  corpoTabela.addEventListener('click', (event) => {
    const botao = event.target instanceof Element ? event.target.closest('[data-perfil-consumer]') : null;
    if (!botao) return;
    const cliente = clientesRenderizados[Number(botao.dataset.perfilConsumer)];
    if (cliente?.perfilConsumer) abrirModalPerfilConsumer(cliente);
  });
}
