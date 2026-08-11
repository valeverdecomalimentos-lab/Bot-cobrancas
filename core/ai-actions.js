const crypto = require('crypto');
const { buildAnalytics, filterDebtorsThreshold, filterCustomersWithPhone, getDebtAmount } = require('./customer-utils');
const { buildProductAnalytics } = require('./product-utils');

const TOOL_DEFINITIONS = Object.freeze([
    { name: 'resumo_operacao', mode: 'read', description: 'Retorna indicadores financeiros, de estoque e campanhas.' },
    { name: 'buscar_clientes', mode: 'read', description: 'Busca clientes locais por nome, status ou faixa de divida.' },
    { name: 'buscar_produtos', mode: 'read', description: 'Busca produtos locais por nome, codigo, categoria ou estoque.' },
    { name: 'listar_campanhas', mode: 'read', description: 'Lista metadados de campanhas e resultados salvos.' },
    { name: 'listar_importacoes', mode: 'read', description: 'Lista importacoes e falhas de sincronizacao.' },
    { name: 'preparar_cobranca', mode: 'prepare', description: 'Prepara uma selecao de cobranca para revisao humana; nunca envia.' },
    { name: 'preparar_notificacao', mode: 'prepare', description: 'Prepara um rascunho de notificacao para revisao humana; nunca envia.' },
    { name: 'preparar_lembrete', mode: 'prepare', description: 'Prepara dados de um lembrete; nunca agenda nem envia.' },
    { name: 'preparar_relatorio', mode: 'prepare', description: 'Prepara a especificacao de um relatorio; nunca grava nem distribui.' },
]);

function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function hasNumericValue(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function limitFrom(args = {}, maximum = 100) {
    const parsed = Number(args.limit ?? 25);
    return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? Math.round(parsed) : 25));
}

function safeCustomer(customer = {}) {
    return {
        id: customer.id,
        nome: customer.nome,
        saldoDevedor: Number(getDebtAmount(customer) || 0),
        status: customer.status || '',
        ultimaCompra: customer.ultimaCompra || '',
        possuiTelefone: Boolean(customer.telefone || customer.telefoneValido || customer.telefoneOriginal),
    };
}

function safeProduct(product = {}) {
    return {
        id: product.id,
        codigo: product.codigo || '',
        nome: product.nome || '',
        categoria: product.categoria || '',
        estoque: hasNumericValue(product.estoque) ? Number(product.estoque) : null,
        estoqueMinimo: hasNumericValue(product.estoqueMinimo) ? Number(product.estoqueMinimo) : null,
        precoCusto: Number(product.precoCusto || 0),
        precoVenda: Number(product.precoVenda || 0),
    };
}

function campaignSummary(reports = []) {
    const valid = reports.filter((report) => Number.isFinite(Number(report.total)));
    const total = valid.reduce((sum, report) => sum + Number(report.total || 0), 0);
    const sent = valid.reduce((sum, report) => sum + Number(report.enviados || 0), 0);
    const errors = valid.reduce((sum, report) => sum + Number(report.erros || 0), 0);
    const ignored = valid.reduce((sum, report) => sum + Number(report.ignorados || 0), 0);
    return {
        campanhas: valid.length,
        processados: total,
        enviados: sent,
        erros: errors,
        ignorados: ignored,
        taxaSucessoPercentual: total ? Number(((sent / total) * 100).toFixed(2)) : 0,
        taxaErroPercentual: total ? Number(((errors / total) * 100).toFixed(2)) : 0,
    };
}

function listAvailableTools() {
    return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
}

function runReadOnlyTool(name, datasets = {}, args = {}) {
    const customers = Array.isArray(datasets.customers) ? datasets.customers : [];
    const products = Array.isArray(datasets.products) ? datasets.products : [];
    const imports = Array.isArray(datasets.imports) ? datasets.imports : [];
    const reports = Array.isArray(datasets.reports) ? datasets.reports : [];
    const limit = limitFrom(args);
    const query = normalize(args.query).trim();

    switch (name) {
    case 'resumo_operacao':
        return {
            financeiro: buildAnalytics(customers).store,
            estoque: buildProductAnalytics(products),
            campanhas: campaignSummary(reports),
            importacoes: {
                total: imports.length,
                comErro: imports.filter((item) => item.status === 'erro').length,
            },
        };
    case 'buscar_clientes': {
        const parsedMinimumDebt = Number(args.minimumDebt ?? 0);
        const parsedMaximumDebt = Number(args.maximumDebt ?? Number.POSITIVE_INFINITY);
        const minimumDebt = Number.isFinite(parsedMinimumDebt) ? parsedMinimumDebt : 0;
        const maximumDebt = Number.isFinite(parsedMaximumDebt) ? parsedMaximumDebt : Number.POSITIVE_INFINITY;
        const records = customers
            .filter((customer) => {
                const debt = Number(getDebtAmount(customer) || 0);
                const haystack = normalize(`${customer.nome} ${customer.status}`);
                return (!query || haystack.includes(query)) && debt >= minimumDebt && debt <= maximumDebt;
            })
            .sort((left, right) => getDebtAmount(right) - getDebtAmount(left));
        return { totalEncontrado: records.length, resultados: records.slice(0, limit).map(safeCustomer) };
    }
    case 'buscar_produtos': {
        const lowStockOnly = Boolean(args.lowStockOnly);
        const records = products.filter((product) => {
            const haystack = normalize(`${product.codigo} ${product.nome} ${product.categoria}`);
            const lowStock = hasNumericValue(product.estoque) && (
                hasNumericValue(product.estoqueMinimo)
                    ? Number(product.estoque) <= Number(product.estoqueMinimo)
                    : /baixo|zerado/.test(normalize(product.situacaoEstoque))
            );
            return (!query || haystack.includes(query)) && (!lowStockOnly || lowStock);
        });
        return { totalEncontrado: records.length, resultados: records.slice(0, limit).map(safeProduct) };
    }
    case 'listar_campanhas':
        return {
            resumo: campaignSummary(reports),
            resultados: reports.slice(0, limit).map((report) => ({
                id: report.id,
                data: report.data,
                tipo: report.tipo,
                total: report.total,
                enviados: report.enviados,
                erros: report.erros,
                ignorados: report.ignorados,
            })),
        };
    case 'listar_importacoes':
        return {
            total: imports.length,
            resultados: imports.slice(0, limit).map((item) => ({
                id: item.id,
                data: item.data,
                arquivo: item.arquivo,
                tipo: item.tipo,
                formato: item.formato,
                status: item.status,
                totalLido: item.totalLido,
                created: item.created,
                updated: item.updated,
                ignored: item.ignored,
                erro: item.erro || '',
            })),
        };
    default:
        throw new Error(`Ferramenta de leitura desconhecida: ${name}.`);
    }
}

function proposalId(kind, payload) {
    return `proposta:${kind}:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

function proposal(kind, payload, validation = {}) {
    return {
        id: proposalId(kind, payload),
        kind,
        state: 'draft',
        executable: false,
        requiresHumanApproval: true,
        createdAt: new Date().toISOString(),
        payload,
        validation,
        safeguards: [
            'Nenhum envio, agendamento ou gravacao foi executado.',
            'O usuario deve revisar destinatarios e conteudo.',
            'Uma confirmacao humana e um envio de teste sao obrigatorios antes de qualquer campanha.',
        ],
    };
}

function prepareOperationalAction(name, datasets = {}, input = {}) {
    const customers = Array.isArray(datasets.customers) ? datasets.customers : [];
    const reports = Array.isArray(datasets.reports) ? datasets.reports : [];
    const whatsappConnected = String(datasets.runtime?.whatsapp?.status || '').toLowerCase() === 'conectado';
    const requestedMaximum = Number(input.maximumRecipients ?? 1000);
    const maximumRecipients = Math.min(5000, Math.max(1, Number.isFinite(requestedMaximum) ? Math.round(requestedMaximum) : 1000));

    switch (name) {
    case 'preparar_cobranca': {
        const requestedThreshold = Number(input.minimumDebt ?? 50);
        const threshold = Math.max(0, Number.isFinite(requestedThreshold) ? requestedThreshold : 50);
        const eligible = filterDebtorsThreshold(customers, threshold);
        const selected = eligible.slice(0, maximumRecipients);
        const payload = {
            campaignType: 'cobranca',
            minimumDebt: threshold,
            recipientIds: selected.map((customer) => String(customer.id)),
            recipientCount: selected.length,
            totalEligible: eligible.length,
            totalDebtSelected: Number(selected.reduce((sum, customer) => sum + getDebtAmount(customer), 0).toFixed(2)),
            messageDraft: String(input.messageDraft || '').trim().slice(0, 4000),
        };
        return proposal('campaign', payload, {
            truncatedSelection: eligible.length > selected.length,
            missingMessage: !payload.messageDraft,
            requiresWhatsappConnection: true,
            whatsappConnected,
            requiresTestSend: true,
        });
    }
    case 'preparar_notificacao': {
        const eligible = filterCustomersWithPhone(customers);
        const requestedIds = new Set(Array.isArray(input.recipientIds) ? input.recipientIds.map(String) : []);
        const selected = (requestedIds.size ? eligible.filter((customer) => requestedIds.has(String(customer.id))) : eligible)
            .slice(0, maximumRecipients);
        const payload = {
            campaignType: 'notificacao',
            recipientIds: selected.map((customer) => String(customer.id)),
            recipientCount: selected.length,
            messageDraft: String(input.messageDraft || '').trim().slice(0, 4000),
        };
        return proposal('notification', payload, {
            missingMessage: !payload.messageDraft,
            requiresWhatsappConnection: true,
            whatsappConnected,
            requiresTestSend: true,
        });
    }
    case 'preparar_lembrete': {
        const payload = {
            title: String(input.title || '').trim().slice(0, 200),
            dateTime: String(input.dateTime || '').trim().slice(0, 80),
            messageDraft: String(input.messageDraft || '').trim().slice(0, 4000),
            recipientIds: Array.isArray(input.recipientIds) ? input.recipientIds.map(String).slice(0, maximumRecipients) : [],
        };
        return proposal('reminder', payload, {
            missingTitle: !payload.title,
            missingDateTime: !payload.dateTime,
            schedulerAvailable: false,
        });
    }
    case 'preparar_relatorio': {
        const payload = {
            reportType: String(input.reportType || 'operacional').slice(0, 80),
            period: String(input.period || 'base atual').slice(0, 120),
            format: ['csv', 'xlsx', 'txt', 'markdown'].includes(input.format) ? input.format : 'markdown',
            availableCampaignReports: reports.length,
        };
        return proposal('report', payload, { destinationRequiredBeforeDistribution: true });
    }
    default:
        throw new Error(`Acao de preparacao desconhecida: ${name}.`);
    }
}

function detectPreparedActions(question, datasets = {}) {
    const text = normalize(question);
    const asksToAct = /\b(envi|mand|dispar|agend|program|prepar|cri|mont|ger)\w*/.test(text);
    if (!asksToAct) return [];
    if (/\b(cobr|inadimpl|devedor)\w*/.test(text)) return [prepareOperationalAction('preparar_cobranca', datasets)];
    if (/\b(lembret|evento|agenda)\w*/.test(text)) return [prepareOperationalAction('preparar_lembrete', datasets)];
    if (/\b(relator|relat[oó]rio)\w*/.test(text)) return [prepareOperationalAction('preparar_relatorio', datasets)];
    if (/\b(notific|avis|mensagem|whatsapp)\w*/.test(text)) return [prepareOperationalAction('preparar_notificacao', datasets)];
    return [];
}

module.exports = {
    listAvailableTools,
    runReadOnlyTool,
    prepareOperationalAction,
    detectPreparedActions,
    campaignSummary,
};
