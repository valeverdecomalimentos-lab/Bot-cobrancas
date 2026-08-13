'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    ENTITY_DEFINITIONS,
    buildEntityQuery,
    extractConsumerBackup,
    parseSetListOutput,
    validateSnapshot,
} = require('../core/consumer-extractor');

function emptySnapshot() {
    const entities = Object.fromEntries(ENTITY_DEFINITIONS.map(({ key }) => [key, []]));
    const counts = Object.fromEntries(ENTITY_DEFINITIONS.map(({ key }) => [key, 0]));
    return {
        schemaVersion: 1,
        source: { format: 'consumer-firebird', fileName: 'backup-sintetico.fbconsumer', sizeBytes: 32 },
        extractedAt: '2026-08-12T12:00:00.000Z',
        entities,
        counts,
    };
}

test('interpreta SET LIST sem depender de dados pessoais reais', () => {
    const fields = [
        { alias: 'F001', name: 'id', type: 'integer' },
        { alias: 'F002', name: 'descricao', type: 'string' },
        { alias: 'F003', name: 'valor', type: 'number' },
        { alias: 'F004', name: 'ocorridoEm', type: 'date' },
        { alias: 'F005', name: 'ativo', type: 'boolean' },
        { alias: 'F006', name: 'opcional', type: 'string' },
    ];
    const output = [
        'Database: localhost:banco-temporario.fdb',
        'F001                           41',
        'F002                           Registro sintetico A',
        'F003                           19.7500',
        'F004                           2026-08-12 09:10:11.1234',
        'F005                           1',
        'F006                           <null>',
        '',
        'F001                           42',
        'F002                           Registro sintetico B',
        'F003                           -5,25',
        'F004                           2026-08-13',
        'F005                           N',
        'F006                           ',
        '',
    ].join('\r\n');

    assert.deepEqual(parseSetListOutput(output, fields), [
        {
            id: 41,
            descricao: 'Registro sintetico A',
            valor: 19.75,
            ocorridoEm: '2026-08-12T09:10:11.123',
            ativo: true,
            opcional: null,
        },
        {
            id: 42,
            descricao: 'Registro sintetico B',
            valor: -5.25,
            ocorridoEm: '2026-08-13',
            ativo: false,
            opcional: '',
        },
    ]);
});

test('valida estrutura, tipos, contagens e identificadores duplicados', () => {
    const snapshot = emptySnapshot();
    snapshot.entities.contatos.push({ id: 7, nome: 'Contato sintetico', ativo: true });
    snapshot.counts.contatos = 1;
    assert.deepEqual(validateSnapshot(snapshot), { valid: true, errors: [] });

    snapshot.entities.contatos.push({ id: 7, saldoAtual: Number.NaN });
    snapshot.counts.contatos = 3;
    const result = validateSnapshot(snapshot);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('saldoAtual')));
    assert.ok(result.errors.some((message) => message.includes('identificador duplicado')));
    assert.ok(result.errors.some((message) => message.includes('counts.contatos')));
});

test('queries consolidam cliente, produto, pagamento e variacao da divida', () => {
    const query = (key) => buildEntityQuery(ENTITY_DEFINITIONS.find((item) => item.key === key));
    assert.match(query('pedidos'), /COALESCE\(CODIGOCONTATOCLIENTE, CODIGOCONTATOFIADO\)/);
    assert.match(query('itensPedido'), /LEFT JOIN PRODUTODETALHE/);
    assert.match(query('itensPedido'), /COALESCE\(IP\.CODIGOPRODUTO, PD\.CODIGOPRODUTO\)/);
    assert.match(query('pagamentos'), /COALESCE\(PG\.CODIGOCONTATO, PE\.CODIGOCONTATOCLIENTE, PE\.CODIGOCONTATOFIADO\)/);
    assert.match(query('contaCorrente'), /COALESCE\(CREDITO, 0\) \+ COALESCE\(DEBITO, 0\)/);
    assert.match(query('pedidos'), /CASE WHEN DATADELETE IS NULL THEN 0 ELSE 1 END/);
});

test('restaura em read_only, usa credenciais no ambiente e sempre limpa o FDB', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-extractor-test-'));
    const backupPath = path.join(temporaryRoot, 'backup-sintetico.fbconsumer');
    fs.writeFileSync(backupPath, Buffer.from([0, 2, 4, 11]));
    const calls = [];

    try {
        const snapshot = await extractConsumerBackup(backupPath, {
            tempRoot: temporaryRoot,
            tools: { gbak: 'C:\\ferramentas\\gbak.exe', isql: 'C:\\ferramentas\\isql.exe', major: 4 },
            verifyTools: false,
            username: 'USUARIO_TESTE',
            password: 'SEGREDO_TESTE',
            now: new Date('2026-08-12T15:00:00.000Z'),
            exec: async (command, args, options) => {
                calls.push({ command, args, options });
                return { code: 0, stdout: '', stderr: '' };
            },
        });

        assert.equal(validateSnapshot(snapshot).valid, true);
        assert.deepEqual(calls[0].args.slice(0, 3), ['-create_database', '-mode', 'read_only']);
        assert.ok(calls[0].args.at(-1).startsWith('localhost:'));
        assert.equal(calls[0].args.includes('SEGREDO_TESTE'), false);
        assert.equal(calls[0].options.env.ISC_USER, 'USUARIO_TESTE');
        assert.equal(calls[0].options.env.ISC_PASSWORD, 'SEGREDO_TESTE');
        assert.equal(calls.length, ENTITY_DEFINITIONS.length + 1);
        for (const call of calls.slice(1)) assert.deepEqual(call.args.slice(0, 3), ['-q', '-ch', 'UTF8']);
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.startsWith('valeverde-consumer-')),
            [],
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('arquivo .fb que não é gbak é consultado somente por uma cópia isolada', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-extractor-raw-fb-'));
    const databaseSource = path.join(temporaryRoot, 'consumer-sintetico.fb');
    const original = Buffer.from('banco-firebird-sintetico');
    fs.writeFileSync(databaseSource, original);
    const calls = [];

    try {
        const snapshot = await extractConsumerBackup(databaseSource, {
            tempRoot: temporaryRoot,
            tools: { gbak: 'C:\\ferramentas\\gbak.exe', isql: 'C:\\ferramentas\\isql.exe', major: 4 },
            verifyTools: false,
            exec: async (command, args, options) => {
                calls.push({ command, args, options });
                if (command.endsWith('gbak.exe')) throw new Error('nao e um stream gbak');
                assert.ok(args.at(-1).startsWith('localhost:'));
                assert.notEqual(args.at(-1), databaseSource);
                return { code: 0, stdout: '', stderr: '' };
            },
        });

        assert.equal(snapshot.source.format, 'consumer-firebird-database-copy');
        assert.equal(calls.length, ENTITY_DEFINITIONS.length + 1);
        assert.deepEqual(fs.readFileSync(databaseSource), original);
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.startsWith('valeverde-consumer-')),
            [],
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('aceita aliases gbak mas nunca usa fallback de banco bruto para eles', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-alias-test-'));
    const backupPath = path.join(temporaryRoot, 'backup.gbk');
    fs.writeFileSync(backupPath, 'backup-sintetico');
    let processCalls = 0;
    try {
        await assert.rejects(extractConsumerBackup(backupPath, {
            tempRoot: temporaryRoot,
            gbakPath: 'gbak',
            isqlPath: 'isql',
            exec: async () => {
                processCalls += 1;
                const error = new Error('nao e um backup valido');
                error.code = 1;
                throw error;
            },
        }), (error) => error.code === 'RESTORE_FAILED');
        assert.equal(processCalls, 1);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('remove a restauracao parcial quando uma consulta falha', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-extractor-failure-'));
    const backupPath = path.join(temporaryRoot, 'backup-sintetico.fbconsumer');
    fs.writeFileSync(backupPath, Buffer.from([0, 2, 4, 11]));
    let calls = 0;

    try {
        await assert.rejects(
            extractConsumerBackup(backupPath, {
                tempRoot: temporaryRoot,
                tools: { gbak: 'C:\\ferramentas\\gbak.exe', isql: 'C:\\ferramentas\\isql.exe' },
                verifyTools: false,
                exec: async () => {
                    calls += 1;
                    if (calls > 1) throw new Error('falha sintetica');
                    return { code: 0, stdout: '', stderr: '' };
                },
            }),
            (error) => error.code === 'QUERY_FAILED',
        );
        assert.deepEqual(
            fs.readdirSync(temporaryRoot).filter((name) => name.startsWith('valeverde-consumer-')),
            [],
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
