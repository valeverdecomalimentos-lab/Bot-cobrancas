const { cleanText, parseMoney, slugify } = require('./customer-utils');

function normalizedHeader(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function getField(row, candidates) {
    const entries = Object.entries(row || {});
    for (const candidate of candidates) {
        const key = entries.find(([name]) => normalizedHeader(name) === candidate)?.[0];
        if (key && row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    }
    for (const candidate of candidates) {
        const key = entries.find(([name]) => normalizedHeader(name).includes(candidate))?.[0];
        if (key && row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    }
    return undefined;
}

function parseQuantity(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = cleanText(value).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCode(value) {
    return cleanText(value).replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function hasProductCode(value) {
    const code = normalizeCode(value);
    return Boolean(code && code !== '0');
}

function productIdentity(product) {
    const code = normalizeCode(product.codigo);
    const name = slugify(product.nome);
    if (hasProductCode(code) && name) return `codigo:${code.toLowerCase()}|nome:${name}`;
    if (hasProductCode(code)) return `codigo:${code.toLowerCase()}`;
    return name ? `nome:${name}` : '';
}

function normalizeProduct(input = {}, options = {}) {
    const row = input.linhaRaw && typeof input.linhaRaw === 'object' ? input.linhaRaw : input;
    const codigo = normalizeCode(getField(row, ['codbusca', 'codigo', 'codigopdv', 'sku', 'cod']) ?? input.codigo);
    const nome = cleanText(getField(row, ['nomeproduto', 'produto', 'nome', 'descricao']) ?? input.nome);
    const categoria = cleanText(getField(row, ['categoria', 'grupo', 'secao']) ?? input.categoria);
    if (!codigo && /^\d+$/.test(nome) && !categoria) return null;
    const chaveProduto = productIdentity({ codigo, nome });
    if (!chaveProduto) return null;

    const estoqueField = Object.entries(row).find(([key]) => {
        const header = normalizedHeader(key);
        return header.includes('estoque') && !header.includes('min');
    })?.[1];
    const now = options.now || new Date().toISOString();
    return {
        ...input,
        id: input.id || `produto-${chaveProduto.replace(':', '-')}`,
        chaveProduto,
        codigo,
        nome,
        categoria,
        precoCusto: parseMoney(getField(row, ['precocusto', 'custo']) ?? input.precoCusto ?? input.preco_custo),
        precoVenda: parseMoney(getField(row, ['precovenda', 'valorvenda', 'venda']) ?? input.precoVenda ?? input.preco_venda),
        medida: cleanText(getField(row, ['medida', 'unidade', 'un']) ?? input.medida),
        estoque: parseQuantity(estoqueField ?? input.estoque),
        estoqueMinimo: parseQuantity(getField(row, ['estoquemin', 'minimo']) ?? input.estoqueMinimo),
        situacaoEstoque: cleanText(getField(row, ['situacaoestoque', 'statusestoque']) ?? input.situacaoEstoque),
        statusVenda: cleanText(getField(row, ['statusvenda', 'ativo']) ?? input.statusVenda),
        origem: options.source || input.origem || '',
        atualizadoEm: now,
        criadoEm: input.criadoEm || now,
        linhaRaw: options.keepRaw === false ? undefined : row,
    };
}

function mergeProduct(existing, incoming) {
    const merged = { ...existing };
    Object.entries(incoming).forEach(([field, value]) => {
        if (!['id', 'criadoEm', 'linhaRaw'].includes(field) && value !== undefined && value !== null && value !== '') {
            merged[field] = value;
        }
    });
    merged.id = existing.id || incoming.id;
    merged.criadoEm = existing.criadoEm || incoming.criadoEm;
    merged.linhaRaw = incoming.linhaRaw;
    merged.chaveProduto = productIdentity(merged);
    return merged;
}

function upsertProducts(existingProducts = [], incomingRows = [], options = {}) {
    const products = [];
    const index = new Map();
    const now = options.now || new Date().toISOString();
    let created = 0;
    let updated = 0;
    let ignored = 0;

    existingProducts.forEach((product) => {
        const normalized = normalizeProduct(product, { now, keepRaw: false }) || product;
        products.push(normalized);
        if (normalized.chaveProduto) index.set(normalized.chaveProduto, products.length - 1);
    });
    incomingRows.forEach((row) => {
        const incoming = normalizeProduct(row, { ...options, now, keepRaw: true });
        if (!incoming) {
            ignored += 1;
            return;
        }
        const position = index.get(incoming.chaveProduto);
        if (position === undefined) {
            products.push(incoming);
            index.set(incoming.chaveProduto, products.length - 1);
            created += 1;
            return;
        }
        products[position] = mergeProduct(products[position], incoming);
        index.set(products[position].chaveProduto, position);
        updated += 1;
    });

    products.sort((a, b) => cleanText(a.nome).localeCompare(cleanText(b.nome), 'pt-BR'));
    return { products, created, updated, ignored, total: incomingRows.length };
}

function isLowStock(product = {}) {
    if (!Number.isFinite(product.estoque)) return false;
    if (Number.isFinite(product.estoqueMinimo)) return product.estoque <= product.estoqueMinimo;
    return /abaixo|baixo|zerado/i.test(String(product.situacaoEstoque || ''));
}

function buildProductAnalytics(products = []) {
    const normalized = products.map((product) => normalizeProduct(product, { keepRaw: false })).filter(Boolean);
    const lowStock = normalized.filter(isLowStock);
    const saleBelowCost = normalized.filter((product) => Number(product.precoCusto) > 0 && Number(product.precoVenda) > 0 && product.precoVenda < product.precoCusto);
    return {
        totalProdutos: normalized.length,
        baixoEstoque: lowStock.length,
        semCodigo: normalized.filter((product) => !hasProductCode(product.codigo)).length,
        vendaAbaixoCusto: saleBelowCost.length,
        amostraBaixoEstoque: lowStock.slice(0, 30).map((product) => ({ nome: product.nome, estoque: product.estoque, estoqueMinimo: product.estoqueMinimo })),
    };
}

module.exports = {
    normalizeProduct,
    upsertProducts,
    isLowStock,
    buildProductAnalytics,
};
