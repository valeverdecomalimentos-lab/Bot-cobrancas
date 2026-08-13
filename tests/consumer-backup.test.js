'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    adaptConsumerSnapshot,
    cents,
    importConsumerBackup,
    localDateTime,
    parseBackupFileName,
} = require('../core/consumer-backup');
const { BusinessContextService } = require('../core/ai-context');

function rawSnapshot() {
    return {
        schemaVersion: 1,
        source: { fileName: 'BkpManual_20260812133252_v16.0.3.fbconsumer', sizeBytes: 50 },
        entities: {
            contatos: [{
                id: 10,
                nome: 'Cliente Sintético',
                ativo: true,
                documento: '123.456.789-00',
                celular: '(22) 99999-0000',
                email: 'TESTE@EXAMPLE.COM',
                saldoAtual: 25.35,
                limiteCredito: 100,
                criadoEm: '2026-06-01T10:30:00.000',
            }],
            categorias: [{ id: 4, descricao: 'Bebidas' }],
            produtos: [{ id: 20, nome: 'Produto Sintético', etiquetaId: 4, precoVenda: 8.5, precoCusto: 4, ativo: true, estoqueAtual: 2 }],
            produtoDetalhes: [{ id: 21, produtoId: 20, precoVenda: 9, precoCusto: 4.25, codigoBarras: '7890000000000', ativo: true }],
            origensPedido: [{ id: 2, descricao: 'Balcão' }],
            pedidos: [{ id: 30, clienteId: 10, abertoEm: '2026-08-12T12:00:00.000', fechadoEm: '2026-08-12T12:10:00.000', origemId: 2, valorItens: 18, totalDesconto: 1, valorEntrega: 0, valorTotal: 17, cancelado: false }],
            itensPedido: [{ id: 40, pedidoId: 30, produtoId: 20, produtoDetalheId: 21, quantidade: 2, valorUnitario: 9, valorTotal: 18, nomeProduto: 'Produto Sintético', cancelado: false }],
            formasPagamento: [{ id: 5, descricao: 'PIX' }],
            pagamentos: [{ id: 50, pedidoId: 30, contatoId: 10, formaPagamentoId: 5, valor: 17, pagoEm: '2026-08-12T12:11:00.000', cancelado: false }],
            contaCorrente: [{ id: 60, clienteId: 10, pedidoId: 30, ocorridoEm: '2026-08-12T12:12:00.000', variacaoDivida: -17, saldoInicial: 42.35, saldoFinal: 25.35, debito: -17, credito: 0 }],
            tiposEntrega: [{ id: 7, descricao: 'Retirada no balcão' }],
            entregas: [{ pedidoId: 30, contatoId: 10, tipoEntregaId: 7, frete: 0, retiradoEm: '2026-08-12T12:20:00.000', cidade: 'Cidade Teste', bairro: 'Centro' }],
        },
    };
}

test('interpreta metadados do nome e datas locais do Consumer', () => {
    assert.deepEqual(parseBackupFileName('C:\\tmp\\BkpManual_20260812133252_v16.0.3.fbconsumer'), {
        fileName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        backupCreatedAt: '2026-08-12T13:32:52-03:00',
        consumerVersion: '16.0.3',
    });
    assert.equal(localDateTime('2026-08-12T13:32:52.123'), '2026-08-12T13:32:52.123-03:00');
    assert.equal(localDateTime('2026-08-12T16:32:52Z'), '2026-08-12T16:32:52Z');
    assert.equal(cents(19.999), 2000);
});

test('transforma snapshot bruto em fatos canônicos, centavos e referências externas', () => {
    const snapshot = adaptConsumerSnapshot(rawSnapshot(), {
        sourceKey: 'consumer:teste',
        sha256: 'abc123',
        sourceKind: 'local',
        sourceName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        sizeBytes: 50,
    });

    assert.equal(snapshot.customers[0].externalId, '10');
    assert.equal(snapshot.customers[0].phone, '5522999990000');
    assert.equal(snapshot.customers[0].currentBalanceCents, 2535);
    assert.equal(snapshot.products[0].externalId, '20');
    assert.equal(snapshot.products[0].salePriceCents, 900);
    assert.equal(snapshot.products[0].category, 'Bebidas');
    assert.equal(snapshot.orders[0].orderedAt, '2026-08-12T12:10:00.000-03:00');
    assert.equal(snapshot.orders[0].totalCents, 1700);
    assert.equal(snapshot.orderItems[0].productExternalId, '20');
    assert.equal(snapshot.orderItems[0].quantityMilli, 2000);
    assert.equal(snapshot.orderPayments[0].method, 'PIX');
    assert.equal(snapshot.ledgerEntries[0].amountCents, -1700);
    assert.equal(snapshot.ledgerEntries[0].type, 'payment');
    assert.equal(snapshot.deliveries[0].mode, 'pickup');
    assert.equal(snapshot.deliveries[0].completed, true);
    assert.match(snapshot.warnings[0], /vencimentos/i);
});

test('rejeita item órfão antes de abrir uma transação de persistência', () => {
    const raw = rawSnapshot();
    raw.entities.itensPedido[0].pedidoId = 999;
    assert.throws(
        () => adaptConsumerSnapshot(raw, { sha256: 'abc', sourceKey: 'consumer:teste' }),
        (error) => error.code === 'ORPHAN_ORDER_ITEM',
    );
});

test('rejeita backup sem dados utilizáveis antes de alterar a base', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-empty-test-'));
    const filePath = path.join(directory, 'BkpManual_20260813120000_v16.0.3.fbconsumer');
    fs.writeFileSync(filePath, 'backup-vazio-sintetico');
    const empty = rawSnapshot();
    Object.keys(empty.entities).forEach((key) => { empty.entities[key] = []; });
    let importCalls = 0;
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [],
        importSnapshot: () => { importCalls += 1; },
        close() {},
    };

    try {
        await assert.rejects(
            importConsumerBackup({ filePath, store, extractor: async () => empty }),
            { code: 'EMPTY_BACKUP_SNAPSHOT' },
        );
        assert.equal(importCalls, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('uma assinatura já concluída evita restaurar novamente o Firebird', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-test-'));
    const filePath = path.join(directory, 'BkpManual_20260812133252_v16.0.3.fbconsumer');
    fs.writeFileSync(filePath, 'backup-sintetico');
    let extractionCalls = 0;
    let closed = false;
    const store = {
        initialize() {},
        findCompletedImportByHash: () => ({ id: 99, counts: { customers: 1 }, warnings: [] }),
        getBusinessSummary: () => ({ customers: 1, averageTicketCents: 1700 }),
        close() { closed = true; },
    };

    try {
        const result = await importConsumerBackup({
            filePath,
            store,
            extractor: async () => { extractionCalls += 1; return rawSnapshot(); },
        });
        assert.equal(result.status, 'duplicate');
        assert.equal(result.importacaoId, 99);
        assert.equal(result.resumo.clientes, 1);
        assert.equal(extractionCalls, 0);
        assert.equal(closed, false, 'stores injetados pertencem ao chamador');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('aceita a extensão .fb e impede que snapshot datado mais antigo substitua o atual', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-older-test-'));
    const filePath = path.join(directory, 'BkpManual_20260811120000_v16.0.3.fb');
    fs.writeFileSync(filePath, 'backup-sintetico-anterior');
    let extractionCalls = 0;
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [{
            id: 42,
            status: 'completed',
            backupCreatedAt: '2026-08-12T13:32:52-03:00',
            counts: { customers: 1 },
        }],
        getBusinessSummary: () => ({ customers: 1 }),
        close() {},
    };

    try {
        const result = await importConsumerBackup({
            filePath,
            store,
            extractor: async () => { extractionCalls += 1; return rawSnapshot(); },
        });
        assert.equal(result.status, 'older');
        assert.equal(result.importacaoId, 42);
        assert.equal(extractionCalls, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('aceita aliases usuais de backup gbak sem habilitar fallback de banco bruto', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-alias-test-'));
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [],
        importSnapshot: (snapshot) => ({
            status: 'completed',
            importId: 41,
            counts: { customers: snapshot.customers.length },
            summary: { customers: snapshot.customers.length },
        }),
        close() {},
    };
    try {
        for (const extension of ['.fbk', '.gbk', '.bak', '.backup']) {
            const filePath = path.join(directory, `consumer${extension}`);
            fs.writeFileSync(filePath, `backup-${extension}`);
            const result = await importConsumerBackup({
                filePath,
                store,
                extractor: async () => rawSnapshot(),
            });
            assert.equal(result.status, 'completed');
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('rejeita arquivo novo sem data verificavel quando ja existe snapshot datado', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-undated-test-'));
    const filePath = path.join(directory, 'BkpManual.fbconsumer');
    fs.writeFileSync(filePath, 'conteudo-novo-sem-data');
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [{ id: 42, status: 'completed', backupCreatedAt: '2026-08-13T09:00:00-03:00' }],
        close() {},
    };
    try {
        await assert.rejects(importConsumerBackup({ filePath, store, extractor: async () => rawSnapshot() }), {
            code: 'BACKUP_DATE_UNKNOWN',
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('importa snapshot novo pelo contrato do store e devolve resumo para a interface', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-backup-new-test-'));
    const filePath = path.join(directory, 'BkpManual_20260812133252_v16.0.3.fbconsumer');
    fs.writeFileSync(filePath, 'backup-sintetico-novo');
    let received;
    const progress = [];
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        importSnapshot(snapshot) {
            received = snapshot;
            return {
                status: 'completed',
                importId: 7,
                counts: { customers: 1, products: 1, orders: 1, orderItems: 1, orderPayments: 1, ledgerEntries: 1, deliveries: 1 },
                summary: { customers: 1, averageTicketCents: 1700, outstandingDebtCents: 2535 },
            };
        },
        close() {},
    };

    try {
        const result = await importConsumerBackup({
            filePath,
            store,
            extractor: async () => rawSnapshot(),
            onProgress: (item) => progress.push(item),
        });
        assert.equal(received.source.consumerVersion, '16.0.3');
        assert.equal(received.source.backupCreatedAt, '2026-08-12T13:32:52-03:00');
        assert.equal(result.status, 'completed');
        assert.equal(result.resumo.pedidos, 1);
        assert.equal(result.resumo.saldoEmAbertoCentavos, 2535);
        assert.equal(progress.at(-1).percentual, 100);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('preserva a extensão .fb baixada do Drive para permitir banco bruto isolado', async () => {
    let extractorPath = '';
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [],
        importSnapshot: () => ({
            status: 'completed',
            importId: 8,
            counts: { customers: 1 },
            summary: { customers: 1 },
        }),
        close() {},
    };
    const result = await importConsumerBackup({
        url: 'https://drive.google.com/file/d/1ArquivoConsumerSintetico00000000001/view',
        sourceName: 'consumer-atual.fb',
        store,
        downloader: async (_url, destination) => {
            fs.writeFileSync(destination, 'banco-firebird-sintetico');
            return { fileId: '1ArquivoConsumerSintetico00000000001', fileName: 'consumer-atual.fb' };
        },
        extractor: async (filePath) => {
            extractorPath = filePath;
            return rawSnapshot();
        },
    });

    assert.equal(path.extname(extractorPath), '.fb');
    assert.equal(result.status, 'completed');
});

test('data gravada no nome do backup prevalece sobre Last-Modified do Drive', async () => {
    let received;
    const store = {
        initialize() {},
        findCompletedImportByHash: () => null,
        listImports: () => [],
        importSnapshot(snapshot) {
            received = snapshot;
            return { status: 'completed', importId: 9, counts: { customers: 1 }, summary: { customers: 1 } };
        },
        close() {},
    };

    const result = await importConsumerBackup({
        url: 'https://drive.google.com/file/d/1ArquivoConsumerSintetico00000000002/view',
        sourceName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        modifiedAt: '2026-08-13T18:00:00.000Z',
        store,
        downloader: async (_url, destination) => {
            fs.writeFileSync(destination, 'backup-firebird-sintetico');
            return {
                fileId: '1ArquivoConsumerSintetico00000000002',
                fileName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
                modifiedAt: '2026-08-13T18:00:00.000Z',
            };
        },
        extractor: async () => rawSnapshot(),
    });

    assert.equal(result.status, 'completed');
    assert.equal(received.source.backupCreatedAt, '2026-08-12T13:32:52-03:00');
});

test('contexto da IA recebe métricas Consumer derivadas sem dados brutos', () => {
    const service = new BusinessContextService();
    const profile = {
        orderCount: 4,
        totalPurchasedCents: 12345,
        averageTicketCents: 3086,
        averageDaysBetweenPurchases: 9.5,
        paymentCount: 3,
        paidTotalCents: 10000,
        currentDebtCents: 2345,
        favoriteProducts: [{ name: 'Produto Sintético', category: 'Categoria Teste', quantityMilli: 2500, totalCents: 5000 }],
        paymentMethods: [{ method: 'PIX', count: 3, totalCents: 10000 }],
        preferredFulfillment: 'delivery',
    };
    const bundle = service.build({
        customers: [{ id: 'cliente-teste', nome: 'Cliente Teste', telefone: '5522999990000', saldo_devedor: 23.45, perfilConsumer: profile }],
        consumerAnalytics: {
            imports: 1,
            customers: 1,
            orders: 4,
            revenueCents: 12345,
            averageTicketCents: 3086,
            outstandingDebtCents: 2345,
            topPaymentMethods: [{ method: 'PIX', count: 3, totalCents: 10000 }],
            topCategories: [{ category: 'Categoria Teste', itemCount: 4, quantityMilli: 2500, totalCents: 5000 }],
        },
    }, { operation: 'question', question: 'qual a frequência e ticket do cliente?' });

    assert.equal(bundle.context.resumoHistoricoConsumer.ticketMedio, 30.86);
    assert.equal(bundle.context.detalhes.clientes[0].historicoConsumer.quantidadeCompras, 4);
    assert.equal(bundle.context.detalhes.clientes[0].historicoConsumer.formaPagamentoPreferida, 'PIX');
    assert.equal(bundle.context.detalhes.clientes[0].historicoConsumer.produtosFavoritos[0].nome, 'Produto Sintético');
});

test('contexto da IA cruza dias, produtos e parciais e omite dados pessoais do histórico', () => {
    const service = new BusinessContextService();
    const consumerProfile = {
        name: 'Maria Teste',
        phone: '5511999990000',
        email: 'privado@example.com',
        orderCount: 2,
        totalPurchasedCents: 4500,
        averageTicketCents: 2250,
        averageDaysBetweenPurchases: 7,
        currentDebtCents: 1000,
        partialPaymentOrderCount: 1,
        ordersHistory: [{
            orderedAt: '2026-08-07T09:15:00-03:00',
            origin: 'Balcão',
            totalCents: 2500,
            paymentStatus: 'partial',
            partialPayment: true,
            recordedPaidTotalCents: 1500,
            recordedRemainingCents: 1000,
            items: [{ productName: 'Queijo Minas', category: 'Frios', quantityMilli: 1000, unitPriceCents: 2500, totalCents: 2500 }],
            deliveries: [{ city: 'Cidade privada', neighborhood: 'Bairro privado' }],
        }],
        paymentsHistory: [{ paidAt: '2026-08-07T09:20:00-03:00', method: 'PIX', amountCents: 1500 }],
        ledgerHistory: [{ occurredAt: '2026-08-07T09:21:00-03:00', kind: 'charge', amountCents: 1000, balanceCents: 1000, description: 'observação privada' }],
    };
    const bundle = service.build({
        customers: [{ id: 'maria', nome: 'Maria Teste', perfilConsumer: consumerProfile }],
        consumerProfiles: [consumerProfile],
    }, {
        operation: 'question',
        question: 'Em qual dia Maria compra Queijo e houve pagamento parcial?',
        budgetChars: 100000,
    });

    assert.equal(bundle.context.resumoPadroesConsumer.perfisAnalisados, 1);
    assert.equal(bundle.context.detalhes.perfisComportamentaisConsumer[0].pedidosComPagamentoParcial, 1);
    assert.equal(bundle.context.detalhes.historicosConsumer[0].compras[0].pagamentoParcial, true);
    assert.equal(bundle.context.detalhes.historicosConsumer[0].compras[0].itens[0].produto, 'Queijo Minas');
    assert.match(JSON.stringify(bundle.context), /sexta-feira/);
    assert.doesNotMatch(bundle.json, /5511999990000|privado@example|Cidade privada|Bairro privado|observação privada/);
});

test('empacotamento exclui listas, backups e bancos locais', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.json'), 'utf8'));
    const files = new Set(config.files || []);
    for (const rule of ['!listas/**', '!**/*.fbconsumer', '!**/*.fb', '!**/*.fbk', '!**/*.gbk', '!**/*.bak', '!**/*.backup', '!**/*.fdb', '!**/*.sqlite', '!**/*.sqlite-wal', '!**/*.sqlite-shm']) {
        assert.equal(files.has(rule), true, `regra ausente: ${rule}`);
    }
});
