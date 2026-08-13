'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConsumerStore } = require('../core/consumer-store');

function makeSnapshot(overrides = {}) {
    return {
        schemaVersion: 1,
        source: {
            sourceKey: 'consumer:loja-principal',
            sha256: 'a'.repeat(64),
            sourceKind: 'local_file',
            sourceName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
            sizeBytes: 2700800,
            backupCreatedAt: '2026-08-12T13:32:52-03:00',
            consumerVersion: '16.0.3',
            timezone: 'America/Sao_Paulo',
        },
        warnings: ['Datas de vencimento nao existem neste backup.'],
        customers: [
            {
                externalId: '101',
                name: 'Ana Martins',
                active: true,
                taxId: '123.456.789-00',
                phone: '(11) 99999-0001',
                email: 'ANA@EXAMPLE.COM',
                currentBalanceCents: 3000,
                identifiers: [{ type: 'consumer_id', value: '101' }],
            },
            { externalId: '102', name: 'Bruno Lima', active: true },
        ],
        products: [
            { externalId: '501', name: 'Queijo Minas', category: 'Frios', salePriceCents: 2500 },
            { externalId: '502', name: 'Pao de Queijo', category: 'Congelados', salePriceCents: 1800 },
        ],
        orders: [
            { externalId: '9001', customerExternalId: '101', orderedAt: '2026-08-01T10:00:00-03:00', totalCents: 10000, origin: 'loja' },
            { externalId: '9002', customerExternalId: '101', orderedAt: '2026-08-11T10:00:00-03:00', totalCents: 5000, origin: 'whatsapp' },
            { externalId: '9003', customerExternalId: '102', orderedAt: '2026-08-12T10:00:00-03:00', totalCents: 2000 },
            { externalId: '9999', customerExternalId: '102', orderedAt: '2026-08-12T11:00:00-03:00', totalCents: 9900, cancelled: true },
        ],
        orderItems: [
            { externalId: 'i1', orderExternalId: '9001', productExternalId: '501', productName: 'Queijo Minas', category: 'Frios', quantityMilli: 2000, unitPriceCents: 2500, totalCents: 5000 },
            { externalId: 'i2', orderExternalId: '9001', productExternalId: '502', productName: 'Pao de Queijo', category: 'Congelados', quantityMilli: 1000, unitPriceCents: 5000, totalCents: 5000 },
            { externalId: 'i3', orderExternalId: '9002', productExternalId: '501', productName: 'Queijo Minas', category: 'Frios', quantityMilli: 2000, unitPriceCents: 2500, totalCents: 5000 },
            { externalId: 'i4', orderExternalId: '9003', productExternalId: '502', productName: 'Pao de Queijo', category: 'Congelados', quantityMilli: 1000, unitPriceCents: 2000, totalCents: 2000 },
        ],
        orderPayments: [
            { externalId: 'pay1', orderExternalId: '9001', paidAt: '2026-08-02T09:00:00-03:00', method: 'PIX', amountCents: 7000 },
            { externalId: 'pay2', orderExternalId: '9003', customerExternalId: '102', paidAt: '2026-08-12T10:05:00-03:00', method: 'Dinheiro', amountCents: 2000 },
            { externalId: 'pay3', paidAt: '2026-08-05T09:00:00-03:00', method: 'Dinheiro', amountCents: 500 },
        ],
        ledgerEntries: [
            { externalId: 'l1', customerExternalId: '101', orderExternalId: '9001', occurredAt: '2026-08-01T10:00:00-03:00', type: 'charge', amountCents: 10000, balanceCents: 10000 },
            { externalId: 'l2', customerExternalId: '101', paymentExternalId: 'pay1', occurredAt: '2026-08-02T09:00:00-03:00', type: 'payment', amountCents: -7000, balanceCents: 3000 },
            { externalId: 'l3', customerExternalId: '102', orderExternalId: '9003', occurredAt: '2026-08-12T10:00:00-03:00', type: 'charge', amountCents: 2000 },
            { externalId: 'l4', customerExternalId: '102', paymentExternalId: 'pay2', occurredAt: '2026-08-12T10:05:00-03:00', type: 'payment', amountCents: -2000 },
            { externalId: 'l5', customerExternalId: '101', paymentExternalId: 'pay3', occurredAt: '2026-08-05T09:00:00-03:00', type: 'payment', amountCents: -500, balanceCents: 2500 },
        ],
        deliveries: [
            { externalId: 'd1', orderExternalId: '9002', occurredAt: '2026-08-11T11:00:00-03:00', mode: 'entrega no endereco', city: 'Sao Paulo', neighborhood: 'Centro', feeCents: 500, completed: true },
            { externalId: 'd2', orderExternalId: '9003', occurredAt: '2026-08-12T10:15:00-03:00', mode: 'retirada', completed: true },
        ],
        ...overrides,
    };
}

function withStore(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-store-'));
    const databasePath = path.join(directory, 'consumer.sqlite');
    const store = createConsumerStore({ databasePath }).initialize();
    try {
        return run(store, databasePath);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('importa snapshot atomico e calcula resumo empresarial em centavos', () => {
    withStore((store) => {
        const result = store.importSnapshot(makeSnapshot());

        assert.equal(result.status, 'completed');
        assert.deepEqual(result.counts, {
            customers: 2,
            products: 2,
            orders: 4,
            orderItems: 4,
            orderPayments: 3,
            ledgerEntries: 5,
            deliveries: 2,
        });
        assert.equal(result.import.sourceName, 'BkpManual_20260812133252_v16.0.3.fbconsumer');
        assert.deepEqual(result.import.warnings, ['Datas de vencimento nao existem neste backup.']);

        const summary = store.getBusinessSummary({ sourceKey: 'consumer:loja-principal' });
        assert.equal(summary.customers, 2);
        assert.equal(summary.activeCustomers, 2);
        assert.equal(summary.products, 2);
        assert.equal(summary.orders, 3);
        assert.equal(summary.orderItems, 4);
        assert.equal(summary.payments, 3);
        assert.equal(summary.revenueCents, 17000);
        assert.equal(summary.averageTicketCents, 5667);
        assert.equal(summary.paidTotalCents, 9500);
        assert.equal(summary.ledgerChargeCount, 2);
        assert.equal(summary.debtPaymentCount, 3);
        assert.equal(summary.debtPaidTotalCents, 9500);
        assert.equal(summary.outstandingDebtCents, 3000);
        assert.equal(summary.customersWithDebt, 1);
        assert.deepEqual(summary.fulfillment, { delivery: 1, pickup: 1, other: 0 });
        assert.equal(summary.topPaymentMethods[0].method, 'PIX');
        assert.equal(summary.topCategories[0].category, 'Frios');
    });
});

test('gera perfil de cliente com compras, divida, frequencia, produtos e entrega', () => {
    withStore((store) => {
        store.importSnapshot(makeSnapshot());

        const profile = store.getCustomerProfile('consumer:loja-principal', '101');
        assert.equal(profile.name, 'Ana Martins');
        assert.equal(profile.currentDebtCents, 3000);
        assert.equal(profile.orderCount, 2);
        assert.equal(profile.totalPurchasedCents, 15000);
        assert.equal(profile.averageTicketCents, 7500);
        assert.equal(profile.averageDaysBetweenPurchases, 10);
        assert.equal(profile.paymentCount, 2);
        assert.equal(profile.paidTotalCents, 7500);
        assert.equal(profile.paymentMethods[0].method, 'PIX');
        assert.equal(profile.debtPaymentCount, 2);
        assert.equal(profile.debtPaidTotalCents, 7500);
        assert.equal(profile.lastDebtPaymentAt, '2026-08-05T09:00:00-03:00');
        assert.equal(profile.favoriteProducts[0].name, 'Queijo Minas');
        assert.equal(profile.favoriteProducts[0].quantityMilli, 4000);
        assert.equal(profile.fulfillment.delivery, 1);
        assert.equal(profile.fulfillment.inStore, 1);
        assert.equal(profile.preferredFulfillment, 'delivery');
        assert.ok(profile.identifiers.some((item) => item.type === 'phone' && item.normalizedValue === '11999990001'));
        assert.ok(profile.identifiers.some((item) => item.type === 'email' && item.normalizedValue === 'ana@example.com'));

        const searched = store.listCustomerProfiles({ search: '1199999', sourceKey: 'consumer:loja-principal' });
        assert.deepEqual(searched.map((item) => item.externalId), ['101']);
        assert.deepEqual(store.listCustomerProfiles({ sourceKey: 'consumer:loja-principal', onlyDebtors: true }).map((item) => item.externalId), ['101']);
        assert.equal(store.getCustomerProfile('consumer:loja-principal', 'nao-existe'), null);
    });
});

test('mesmo sourceKey e SHA-256 e idempotente e nao duplica fatos', () => {
    withStore((store) => {
        const first = store.importSnapshot(makeSnapshot());
        const second = store.importSnapshot(makeSnapshot());

        assert.equal(second.status, 'duplicate');
        assert.equal(second.importId, first.importId);
        assert.equal(store.listImports().length, 1);
        assert.equal(store.getBusinessSummary().orders, 3);
        assert.equal(store.findCompletedImportByHash('consumer:loja-principal', 'A'.repeat(64)).id, first.importId);
    });
});

test('cliente inativo e preservado mas nao compoe saldo ativo da loja', () => {
    withStore((store) => {
        const snapshot = makeSnapshot({
            customers: [
                ...makeSnapshot().customers,
                { externalId: '103', name: 'Cliente inativo', active: false, currentBalanceCents: 9900 },
            ],
        });
        store.importSnapshot(snapshot);
        const summary = store.getBusinessSummary({ sourceKey: 'consumer:loja-principal' });
        assert.equal(summary.customers, 3);
        assert.equal(summary.activeCustomers, 2);
        assert.equal(summary.outstandingDebtCents, 3000);
        assert.equal(summary.customersWithDebt, 1);
    });
});

test('novo backup atualiza entidades pelo externalId sem duplicar historico empresarial', () => {
    withStore((store) => {
        store.importSnapshot(makeSnapshot());
        const updated = makeSnapshot({
            source: { ...makeSnapshot().source, sha256: 'b'.repeat(64), sourceName: 'backup-2.fbconsumer' },
            customers: [
                { externalId: '101', name: 'Ana M. Martins', active: true, currentBalanceCents: 1000 },
                { externalId: '102', name: 'Bruno Lima', active: true },
            ],
        });

        const result = store.importSnapshot(updated);
        assert.equal(result.status, 'completed');
        assert.equal(store.listImports().length, 2);
        assert.equal(store.getBusinessSummary().orders, 3);
        assert.equal(store.getCustomerProfile('consumer:loja-principal', '101').name, 'Ana M. Martins');
        assert.equal(store.getCustomerProfile('consumer:loja-principal', '101').currentDebtCents, 1000);
    });
});

test('snapshot completo mais novo aposenta ausentes sem apagar o historico', () => {
    withStore((store) => {
        const original = makeSnapshot();
        store.importSnapshot({
            ...original,
            source: { ...original.source, authoritativeSnapshot: true },
        });
        const current = makeSnapshot({
            source: {
                ...original.source,
                sha256: 'd'.repeat(64),
                backupCreatedAt: '2026-08-13T13:00:00-03:00',
                authoritativeSnapshot: true,
            },
            customers: [{
                externalId: '101',
                name: 'Ana Atualizada',
                active: true,
                phone: '(11) 98888-0001',
                currentBalanceCents: 1000,
            }],
            products: [original.products[0]],
            orders: [original.orders[0]],
            orderItems: [original.orderItems[0]],
            orderPayments: [original.orderPayments[0]],
            ledgerEntries: [original.ledgerEntries[0]],
            deliveries: [],
        });

        store.importSnapshot(current);
        const summary = store.getBusinessSummary({ sourceKey: 'consumer:loja-principal' });
        assert.equal(summary.activeCustomers, 1);
        assert.equal(summary.orders, 1);
        assert.equal(summary.orderItems, 1);
        assert.equal(summary.payments, 1);
        assert.equal(summary.deliveries, 0);
        const ana = store.getCustomerProfile('consumer:loja-principal', '101');
        assert.equal(ana.name, 'Ana Atualizada');
        assert.equal(ana.orderCount, 1);
        assert.equal(ana.ordersHistory.find((order) => order.externalId === '9002').cancelled, true);
        assert.deepEqual(ana.identifiers.filter((item) => item.type === 'phone').map((item) => item.normalizedValue), ['11988880001']);
        assert.equal(store.getCustomerProfile('consumer:loja-principal', '102').active, false);
    });
});

test('snapshot autoritativo vazio e rejeitado sem aposentar dados atuais', () => {
    withStore((store) => {
        const original = makeSnapshot();
        store.importSnapshot({
            ...original,
            source: { ...original.source, authoritativeSnapshot: true },
        });
        const empty = makeSnapshot({
            source: {
                ...original.source,
                sha256: 'f'.repeat(64),
                backupCreatedAt: '2026-08-14T13:00:00-03:00',
                authoritativeSnapshot: true,
            },
            customers: [],
            products: [],
            orders: [],
            orderItems: [],
            orderPayments: [],
            ledgerEntries: [],
            deliveries: [],
        });

        assert.throws(() => store.importSnapshot(empty), /autoritativo vazio/i);
        assert.equal(store.listImports().length, 1);
        const summary = store.getBusinessSummary({ sourceKey: 'consumer:loja-principal' });
        assert.equal(summary.activeCustomers, 2);
        assert.equal(summary.orders, 3);
        assert.equal(summary.products, 2);
    });
});

test('reconcilia o ultimo backup importado antes da marca de snapshot completo', () => {
    withStore((store) => {
        const original = makeSnapshot();
        const first = store.importSnapshot(original);
        const secondSnapshot = makeSnapshot({
            source: { ...original.source, sha256: 'e'.repeat(64), backupCreatedAt: '2026-08-13T14:00:00-03:00' },
            customers: [original.customers[0]],
            products: [original.products[0]],
            orders: [original.orders[0]],
            orderItems: [original.orderItems[0]],
            orderPayments: [original.orderPayments[0]],
            ledgerEntries: [original.ledgerEntries[0]],
            deliveries: [],
        });
        const second = store.importSnapshot(secondSnapshot);
        assert.equal(store.getBusinessSummary().orders, 3);
        assert.deepEqual(store.reconcileCompletedImportAsAuthoritative(first.importId), { reconciled: false, reason: 'not_latest' });
        assert.equal(store.reconcileCompletedImportAsAuthoritative(second.importId).reconciled, true);
        assert.equal(store.getBusinessSummary().orders, 1);
        assert.equal(store.getCustomerProfile('consumer:loja-principal', '102').active, false);
    });
});

test('nao transforma importacao legada vazia em snapshot autoritativo', () => {
    withStore((store) => {
        const original = makeSnapshot();
        store.importSnapshot({
            ...original,
            source: { ...original.source, authoritativeSnapshot: true },
        });
        const emptyLegacy = makeSnapshot({
            source: {
                ...original.source,
                sha256: '9'.repeat(64),
                backupCreatedAt: '2026-08-14T13:00:00-03:00',
            },
            customers: [],
            products: [],
            orders: [],
            orderItems: [],
            orderPayments: [],
            ledgerEntries: [],
            deliveries: [],
        });
        const imported = store.importSnapshot(emptyLegacy);

        assert.deepEqual(
            store.reconcileCompletedImportAsAuthoritative(imported.importId),
            { reconciled: false, reason: 'empty_snapshot' },
        );
        const summary = store.getBusinessSummary({ sourceKey: 'consumer:loja-principal' });
        assert.equal(summary.activeCustomers, 2);
        assert.equal(summary.orders, 3);
        assert.equal(summary.products, 2);
    });
});

test('erro de validacao desfaz toda a transacao', () => {
    withStore((store) => {
        const invalid = makeSnapshot({
            source: { ...makeSnapshot().source, sha256: 'c'.repeat(64) },
            customers: [
                { externalId: 'ok', name: 'Persistiria sem rollback' },
                { externalId: 'bad', name: 'Valor quebrado', currentBalanceCents: 12.34 },
            ],
        });

        assert.throws(() => store.importSnapshot(invalid), /numero inteiro seguro/);
        assert.deepEqual(store.listImports(), []);
        assert.equal(store.getBusinessSummary().customers, 0);
    });
});

test('aceita payments como alias e persiste dados apos reabrir', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-store-reopen-'));
    const databasePath = path.join(directory, 'consumer.sqlite');
    try {
        const snapshot = makeSnapshot();
        snapshot.payments = snapshot.orderPayments;
        delete snapshot.orderPayments;

        const firstStore = createConsumerStore({ databasePath }).initialize();
        firstStore.importSnapshot(snapshot);
        firstStore.close();

        const reopened = createConsumerStore({ databasePath }).initialize();
        assert.equal(reopened.getBusinessSummary().payments, 3);
        assert.equal(reopened.listImports()[0].status, 'completed');
        reopened.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('perfil detalhado traz pedidos, itens, pagamentos e conta-corrente sem inventar vencimento', () => {
    withStore((store) => {
        store.importSnapshot(makeSnapshot());

        const summaries = store.listCustomerProfiles({ sourceKey: 'consumer:loja-principal' });
        const anaSummary = summaries.find((profile) => profile.externalId === '101');
        assert.equal(anaSummary.partialPaymentOrderCount, 1);
        assert.equal(anaSummary.lastPartialPaymentAt, '2026-08-02T09:00:00-03:00');
        assert.equal(Object.hasOwn(anaSummary, 'ordersHistory'), false);
        assert.equal(Object.hasOwn(anaSummary, 'paymentsHistory'), false);
        assert.equal(Object.hasOwn(anaSummary, 'ledgerHistory'), false);

        const profile = store.getCustomerProfile('consumer:loja-principal', '101');
        assert.deepEqual(profile.ordersHistory.map((order) => order.externalId), ['9002', '9001']);
        const partialOrder = profile.ordersHistory.find((order) => order.externalId === '9001');
        assert.equal(partialOrder.orderedAt, '2026-08-01T10:00:00-03:00');
        assert.equal(partialOrder.origin, 'loja');
        assert.equal(partialOrder.totalCents, 10000);
        assert.equal(partialOrder.paymentStatus, 'partial');
        assert.equal(partialOrder.partialPayment, true);
        assert.equal(partialOrder.recordedPaidTotalCents, 7000);
        assert.equal(partialOrder.recordedRemainingCents, 3000);
        assert.deepEqual(partialOrder.paymentEvidence, {
            orderPaymentsCents: 7000,
            associatedLedgerPaymentsCents: 0,
            sources: ['order_payments'],
        });
        assert.equal(partialOrder.items.length, 2);
        assert.deepEqual(partialOrder.items[0], {
            externalId: 'i1',
            productExternalId: '501',
            productName: 'Queijo Minas',
            category: 'Frios',
            quantityMilli: 2000,
            unitPriceCents: 2500,
            totalCents: 5000,
            cancelled: false,
        });
        assert.deepEqual(partialOrder.payments.map((payment) => payment.externalId), ['pay1']);
        assert.equal(Object.hasOwn(partialOrder, 'dueAt'), false);
        assert.equal(Object.hasOwn(partialOrder, 'overdue'), false);

        assert.deepEqual(profile.paymentsHistory.map((payment) => payment.externalId), ['pay3', 'pay1']);
        assert.equal(profile.paymentsHistory[0].orderExternalId, null);
        const linkedLedgerPayment = profile.ledgerHistory.find((entry) => entry.externalId === 'l2');
        assert.equal(linkedLedgerPayment.kind, 'payment');
        assert.equal(linkedLedgerPayment.sourceType, 'payment');
        assert.equal(linkedLedgerPayment.amountCents, -7000);
        assert.equal(linkedLedgerPayment.orderExternalId, '9001');
        assert.equal(linkedLedgerPayment.paymentExternalId, 'pay1');
        assert.equal(profile.ledgerHistory.find((entry) => entry.externalId === 'l1').kind, 'charge');
        assert.equal(profile.historyMeta.truncated.any, false);
    });
});

test('historico inclui cancelados sem usa-los como comprovacao de pagamento', () => {
    withStore((store) => {
        const base = makeSnapshot();
        store.importSnapshot(makeSnapshot({
            orderPayments: [
                ...base.orderPayments,
                {
                    externalId: 'pay-cancelado',
                    orderExternalId: '9002',
                    paidAt: '2026-08-11T10:05:00-03:00',
                    method: 'PIX',
                    amountCents: 5000,
                    cancelled: true,
                },
            ],
            ledgerEntries: [
                ...base.ledgerEntries,
                {
                    externalId: 'ajuste-zero',
                    customerExternalId: '101',
                    occurredAt: '2026-08-06T10:00:00-03:00',
                    type: 'manual',
                    description: 'Registro sem impacto financeiro',
                    amountCents: 0,
                },
            ],
        }));

        const profile = store.getCustomerProfile('consumer:loja-principal', '101');
        const unpaidOrder = profile.ordersHistory.find((order) => order.externalId === '9002');
        assert.equal(unpaidOrder.paymentStatus, 'unpaid');
        assert.equal(unpaidOrder.recordedPaidTotalCents, 0);
        assert.equal(unpaidOrder.payments[0].externalId, 'pay-cancelado');
        assert.equal(unpaidOrder.payments[0].cancelled, true);
        assert.equal(profile.paymentCount, 2);
        assert.equal(profile.paymentsHistory.find((payment) => payment.externalId === 'pay-cancelado').cancelled, true);
        assert.equal(profile.ledgerHistory.find((entry) => entry.externalId === 'ajuste-zero').kind, 'adjustment');

        const bruno = store.getCustomerProfile('consumer:loja-principal', '102');
        const cancelledOrder = bruno.ordersHistory.find((order) => order.externalId === '9999');
        assert.equal(cancelledOrder.cancelled, true);
        assert.equal(cancelledOrder.paymentStatus, 'cancelled');
        assert.equal(bruno.orderCount, 1);
    });
});

test('limites de historico sao configuraveis e declaram qualquer truncamento', () => {
    withStore((store) => {
        store.importSnapshot(makeSnapshot());
        const options = {
            sourceKey: 'consumer:loja-principal',
            externalId: '101',
            historyLimits: {
                orders: 2,
                payments: 1,
                ledger: 1,
                itemsPerOrder: 1,
                paymentsPerOrder: 1,
                deliveriesPerOrder: 1,
            },
        };
        const profile = store.getCustomerProfile(options);

        assert.equal(profile.ordersHistory.length, 2);
        assert.equal(profile.paymentsHistory.length, 1);
        assert.equal(profile.ledgerHistory.length, 1);
        assert.equal(profile.ordersHistory.find((order) => order.externalId === '9001').items.length, 1);
        assert.deepEqual(profile.historyMeta.totals, {
            orders: 2,
            payments: 2,
            ledger: 3,
            items: 3,
            deliveries: 1,
        });
        assert.equal(profile.historyMeta.truncated.orders, false);
        assert.equal(profile.historyMeta.truncated.payments, true);
        assert.equal(profile.historyMeta.truncated.ledger, true);
        assert.equal(profile.historyMeta.truncated.items, true);
        assert.equal(profile.historyMeta.truncated.any, true);

        const explicitHistoryList = store.listCustomerProfiles({
            sourceKey: 'consumer:loja-principal',
            includeHistory: true,
            historyLimit: 1,
            limit: 1,
        });
        assert.equal(Array.isArray(explicitHistoryList[0].ordersHistory), true);
        assert.equal(explicitHistoryList[0].ordersHistory.length, 1);
    });
});

test('pagamento de conta-corrente explicitamente ligado ao pedido pode comprovar parcial sem duplicar pagamentos', () => {
    withStore((store) => {
        const base = makeSnapshot();
        store.importSnapshot(makeSnapshot({
            ledgerEntries: [
                ...base.ledgerEntries,
                {
                    externalId: 'l-pedido-9002',
                    customerExternalId: '101',
                    orderExternalId: '9002',
                    occurredAt: '2026-08-12T08:00:00-03:00',
                    type: 'payment',
                    amountCents: -2000,
                    balanceCents: 500,
                },
            ],
        }));

        const profile = store.getCustomerProfile('consumer:loja-principal', '101');
        const order = profile.ordersHistory.find((entry) => entry.externalId === '9002');
        assert.equal(order.paymentStatus, 'partial');
        assert.equal(order.recordedPaidTotalCents, 2000);
        assert.equal(order.recordedRemainingCents, 3000);
        assert.deepEqual(order.paymentEvidence, {
            orderPaymentsCents: 0,
            associatedLedgerPaymentsCents: 2000,
            sources: ['ledger_entries'],
        });
        assert.equal(profile.partialPaymentOrderCount, 2);
    });
});
