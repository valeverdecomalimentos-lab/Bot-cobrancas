const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertCustomers } = require('../core/customer-utils');

const NOW = '2026-08-13T12:00:00.000Z';

test('preserva clientes homônimos quando os telefones são diferentes', () => {
    const result = upsertCustomers([
        { id: 'cliente-existente', nome: 'Cliente Homônimo', telefone: '11911110001', valorDevido: 10 },
    ], [
        { nome: 'Cliente Homônimo', telefone: '11911110002', valorDevido: 25 },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.ignored, 0);
    assert.equal(result.customers.length, 2);
    assert.deepEqual(
        result.customers.map((customer) => [customer.telefone, customer.valorDevido]).sort(),
        [['5511911110001', 10], ['5511911110002', 25]],
    );
});

test('não sobrescreve cliente quando um identificador forte coincide e outro diverge', () => {
    const result = upsertCustomers([
        {
            id: 'cliente-existente',
            nome: 'Cliente Protegido',
            cpf: '11122233344',
            telefone: '11911110001',
            valorDevido: 10,
        },
    ], [
        {
            nome: 'Cliente Protegido',
            cpf: '11122233344',
            telefone: '11911110002',
            valorDevido: 99,
        },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.ignored, 1);
    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].telefone, '5511911110001');
    assert.equal(result.customers[0].valorDevido, 10);
});

test('CPF sem telefone não é inferido como contato e preserva o telefone já conhecido', () => {
    const result = upsertCustomers([
        {
            id: 'cliente-existente',
            nome: 'Cliente Original',
            cpf: '11122233344',
            telefone: '11911110001',
            valorDevido: 10,
        },
    ], [
        { nome: 'Cliente Atualizado', cpf: '111.222.333-44', valorDevido: 30 },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.ignored, 0);
    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].nome, 'Cliente Atualizado');
    assert.equal(result.customers[0].telefone, '5511911110001');
    assert.equal(result.customers[0].valorDevido, 30);
});

test('não escolhe arbitrariamente entre nomes ambíguos sem identificador forte', () => {
    const result = upsertCustomers([
        { id: 'homonimo-a', nome: 'Nome Ambíguo', valorDevido: 10 },
        { id: 'homonimo-b', nome: 'Nome Ambíguo', valorDevido: 20 },
    ], [
        { nome: 'Nome Ambíguo', valorDevido: 99 },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.ignored, 1);
    assert.equal(result.customers.length, 2);
    assert.deepEqual(result.customers.map((customer) => customer.valorDevido).sort((a, b) => a - b), [10, 20]);
});

test('permite casar por nome somente quando não há identificador forte e o nome é único', () => {
    const result = upsertCustomers([
        { id: 'cliente-sem-identificador', nome: 'Nome Único', valorDevido: 10 },
    ], [
        { nome: 'Nome Único', valorDevido: 35 },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.ignored, 0);
    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].id, 'cliente-sem-identificador');
    assert.equal(result.customers[0].valorDevido, 35);
});

test('usa CNPJ como identificador forte antes do nome', () => {
    const result = upsertCustomers([
        { id: 'empresa-existente', nome: 'Razão Antiga', cnpj: '12.345.678/0001-90', valorDevido: 10 },
    ], [
        { nome: 'Razão Atualizada', cnpj: '12.345.678/0001-90', valorDevido: 40 },
    ], { now: NOW, keepRaw: false });

    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.ignored, 0);
    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].id, 'empresa-existente');
    assert.equal(result.customers[0].nome, 'Razão Atualizada');
    assert.equal(result.customers[0].cnpj, '12345678000190');
    assert.equal(result.customers[0].chaveCliente, 'cnpj:12345678000190');
    assert.equal(result.customers[0].telefone, '');
});
