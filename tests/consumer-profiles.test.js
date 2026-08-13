'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    combineConsumerCustomers,
    getCustomerProfile,
    listCustomerHistoryProfiles,
} = require('../core/consumer-profiles');

function profile(overrides = {}) {
    return {
        sourceKey: 'consumer:loja-principal',
        externalId: '101',
        name: 'Nome no Consumer',
        active: true,
        taxId: '123.456.789-00',
        phone: '(11) 99999-0001',
        currentDebtCents: 12345,
        orderCount: 4,
        totalPurchasedCents: 45678,
        averageTicketCents: 11420,
        lastPurchaseAt: '2026-08-12T10:00:00-03:00',
        favoriteProducts: [{ externalId: '5', name: 'Queijo', totalCents: 20000 }],
        paymentMethods: [{ method: 'PIX', count: 3, totalCents: 30000 }],
        fulfillment: { delivery: 3, pickup: 1, inStore: 0, other: 0, unknown: 0 },
        extra: { birthDate: '1990-01-01', address: 'Dado desnecessário no renderer' },
        ...overrides,
    };
}

test('funde por telefone exato e unico, preserva o ID e inclui todas as metricas Consumer', () => {
    const existing = [{
        id: 'cliente-planilha-7',
        nome: 'Nome operacional preservado',
        telefone: '11 99999-0001',
        saldo_devedor: 10,
        status: 'em_dia',
        criadoEm: '2026-01-01T00:00:00.000Z',
    }];

    const result = combineConsumerCustomers(existing, [profile()]);

    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].id, 'cliente-planilha-7');
    assert.equal(result.customers[0].nome, 'Nome operacional preservado');
    assert.equal(result.customers[0].saldo_devedor, 123.45);
    assert.equal(result.customers[0].valorDevido, 123.45);
    assert.equal(result.customers[0].status, 'devedor');
    assert.equal(result.customers[0].ultimaCompra, '2026-08-12T10:00:00-03:00');
    assert.equal(result.customers[0].consumerSourceKey, 'consumer:loja-principal');
    assert.equal(result.customers[0].consumerExternalId, '101');
    assert.deepEqual(result.customers[0].perfilConsumer.favoriteProducts, profile().favoriteProducts);
    assert.deepEqual(result.customers[0].perfilConsumer.paymentMethods, profile().paymentMethods);
    assert.equal(result.customers[0].perfilConsumer.extra, undefined);
    assert.equal(result.customers[0].perfilConsumer.phone, undefined);
    assert.equal(result.customers[0].perfilConsumer.taxId, undefined);
    assert.notEqual(result.customers[0].perfilConsumer, profile());
    assert.equal(result.customers[0].perfilAnalitico.elegivelCobranca, true);
    assert.deepEqual(result.stats, {
        existing: 1,
        profiles: 1,
        activeProfiles: 1,
        matched: 1,
        created: 0,
        pending: 0,
        pendingAmbiguous: 0,
        pendingInvalid: 0,
        inactiveSkipped: 0,
        totalCustomers: 1,
    });
});

test('reconhece CPF e CNPJ formatados, inclusive nos identifiers do Consumer', () => {
    const existing = [
        { id: 'cpf-existente', nome: 'CPF', cpf: '12345678900' },
        { id: 'cnpj-existente', nome: 'CNPJ', cnpj: '12.345.678/0001-90' },
    ];
    const profiles = [
        profile({ externalId: 'cpf', phone: null }),
        profile({
            externalId: 'cnpj',
            taxId: null,
            phone: null,
            identifiers: [{ type: 'document', value: '12345678000190' }],
        }),
    ];

    const result = combineConsumerCustomers(existing, profiles);

    assert.equal(result.stats.matched, 2);
    assert.equal(result.stats.created, 0);
    assert.equal(result.customers[0].id, 'cpf-existente');
    assert.equal(result.customers[0].consumerExternalId, 'cpf');
    assert.equal(result.customers[1].id, 'cnpj-existente');
    assert.equal(result.customers[1].consumerExternalId, 'cnpj');
    assert.equal(result.customers[1].cnpj, '12345678000190');
});

test('nunca usa nome para fundir e cria perfil ativo sem colisao com ID estavel', () => {
    const existing = [{ id: 'manual', nome: 'Mesmo Nome', telefone: '' }];
    const consumer = profile({
        externalId: 'sem-identificador',
        name: 'Mesmo Nome',
        taxId: null,
        phone: null,
        identifiers: [],
        currentDebtCents: 0,
    });

    const result = combineConsumerCustomers(existing, [consumer]);

    assert.equal(result.customers.length, 2);
    assert.equal(result.customers[0].id, 'manual');
    assert.equal(result.customers[1].id, 'consumer:consumer:loja-principal:sem-identificador');
    assert.equal(result.customers[1].origem, 'backup_consumer');
    assert.equal(result.customers[1].status, 'sem_telefone');
    assert.equal(result.stats.matched, 0);
    assert.equal(result.stats.created, 1);
});

test('telefone repetido entre clientes existentes fica pendente e nao cria duplicata', () => {
    const existing = [
        { id: 'a', nome: 'A', telefone: '11999990001' },
        { id: 'b', nome: 'B', telefone: '+55 (11) 99999-0001' },
    ];

    const result = combineConsumerCustomers(existing, [profile({ taxId: null })]);

    assert.equal(result.customers.length, 2);
    assert.equal(result.customers.some((customer) => customer.perfilConsumer), false);
    assert.equal(result.stats.pending, 1);
    assert.equal(result.stats.pendingAmbiguous, 1);
    assert.equal(result.stats.matched, 0);
    assert.equal(result.stats.created, 0);
});

test('identificador repetido entre perfis Consumer deixa todos pendentes', () => {
    const profiles = [
        profile({ externalId: '101', taxId: null }),
        profile({ externalId: '102', taxId: null, name: 'Outro perfil' }),
    ];

    const result = combineConsumerCustomers([], profiles);

    assert.deepEqual(result.customers, []);
    assert.equal(result.stats.pending, 2);
    assert.equal(result.stats.pendingAmbiguous, 2);
    assert.equal(result.stats.created, 0);
});

test('identificadores que apontam para clientes diferentes nao autorizam fusao', () => {
    const existing = [
        { id: 'por-cpf', nome: 'Pessoa A', cpf: '12345678900' },
        { id: 'por-fone', nome: 'Pessoa B', telefone: '11999990001' },
    ];

    const result = combineConsumerCustomers(existing, [profile()]);

    assert.equal(result.customers.length, 2);
    assert.equal(result.stats.pendingAmbiguous, 1);
    assert.equal(result.stats.matched, 0);
});

test('dois perfis que reivindicam o mesmo cliente por chaves distintas ficam pendentes', () => {
    const existing = [{
        id: 'cliente-unico',
        nome: 'Cliente',
        cpf: '12345678900',
        telefone: '11999990001',
    }];
    const profiles = [
        profile({ externalId: 'por-cpf', phone: null }),
        profile({ externalId: 'por-fone', taxId: null }),
    ];

    const result = combineConsumerCustomers(existing, profiles);

    assert.equal(result.customers.length, 1);
    assert.equal(result.stats.pending, 2);
    assert.equal(result.stats.pendingAmbiguous, 2);
    assert.equal(result.stats.matched, 0);
});

test('ignora perfil inativo e contabiliza perfil ativo invalido separadamente', () => {
    const result = combineConsumerCustomers([], [
        profile({ externalId: 'inativo', active: false }),
        profile({ sourceKey: '', externalId: '', taxId: null, phone: null }),
        null,
    ]);

    assert.deepEqual(result.customers, []);
    assert.equal(result.stats.inactiveSkipped, 1);
    assert.equal(result.stats.activeProfiles, 1);
    assert.equal(result.stats.pending, 2);
    assert.equal(result.stats.pendingInvalid, 2);
});

test('reaplicar a combinacao atualiza cliente Consumer pelo ID estavel sem duplicar', () => {
    const original = profile({
        externalId: 'sem-documento',
        taxId: null,
        phone: null,
        identifiers: [],
        currentDebtCents: 100,
    });
    const first = combineConsumerCustomers([], [original]);
    const second = combineConsumerCustomers(first.customers, [{
        ...original,
        currentDebtCents: 250,
        lastPurchaseAt: '2026-08-13T08:00:00-03:00',
    }]);

    assert.equal(second.customers.length, 1);
    assert.equal(second.customers[0].id, 'consumer:consumer:loja-principal:sem-documento');
    assert.equal(second.customers[0].saldo_devedor, 2.5);
    assert.equal(second.stats.matched, 1);
    assert.equal(second.stats.created, 0);
});

test('facade lista resumos por padrao e busca um perfil detalhado sob demanda', () => {
    const calls = [];
    const store = {
        listCustomerProfiles(options) {
            calls.push(['list', options]);
            return [{ externalId: '101', orderCount: 2 }];
        },
        getCustomerProfile(sourceKey, externalId) {
            calls.push(['get', sourceKey, externalId]);
            return { externalId, ordersHistory: [] };
        },
    };

    assert.deepEqual(listCustomerHistoryProfiles(store, { sourceKey: 'consumer:loja' }), [
        { externalId: '101', orderCount: 2 },
    ]);
    assert.equal(calls[0][1].includeHistory, false);
    listCustomerHistoryProfiles(store, { sourceKey: 'consumer:loja', includeHistory: true });
    assert.equal(calls[1][1].includeHistory, true);
    assert.deepEqual(getCustomerProfile(store, 'consumer:loja', '101'), {
        externalId: '101',
        ordersHistory: [],
    });
    assert.deepEqual(calls[2], ['get', 'consumer:loja', '101']);
    assert.throws(() => listCustomerHistoryProfiles({}, {}), /ConsumerStore/);
});
