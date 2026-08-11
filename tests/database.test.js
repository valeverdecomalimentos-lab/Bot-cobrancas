const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('migra a estrutura do banco legado sem perder configuracoes', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-db-'));
    const databasePath = path.join(temporaryDirectory, 'valeverde-db.json');
    const previousDirectory = process.env.VALEVERDE_DATA_DIR;
    fs.writeFileSync(databasePath, JSON.stringify({
        version: 1,
        clientes: [],
        produtos: [],
        relatorios: [],
        importacoes: [],
        configuracoes: { chavePix: 'financeiro@example.com' },
    }), 'utf8');

    try {
        process.env.VALEVERDE_DATA_DIR = temporaryDirectory;
        delete require.cache[require.resolve('../core/database')];
        const database = require('../core/database');

        assert.equal(database.getConfig().chavePix, 'financeiro@example.com');
        assert.deepEqual(database.getAiState().conversa, []);
        database.saveConfig({ intervaloMin: 5 });

        const persisted = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        assert.equal(persisted.version, 3);
        assert.equal(persisted.configuracoes.chavePix, 'financeiro@example.com');
        assert.equal(persisted.configuracoes.intervaloMin, 5);
        assert.deepEqual(persisted.ia.conversa, []);
    } finally {
        if (previousDirectory === undefined) delete process.env.VALEVERDE_DATA_DIR;
        else process.env.VALEVERDE_DATA_DIR = previousDirectory;
        delete require.cache[require.resolve('../core/database')];
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});
