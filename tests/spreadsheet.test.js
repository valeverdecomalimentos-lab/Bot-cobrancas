const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { readSpreadsheetRows } = require('../core/spreadsheet');
const { loadSpreadsheetSources, clearSpreadsheetCache } = require('../core/ai-spreadsheets');

test('le todas as abas de uma planilha e preserva a origem de cada linha', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-planilha-'));
    const filePath = path.join(temporaryDirectory, 'base.xlsx');

    try {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
            { Nome: 'Ana', Telefone: '11999990001' },
        ]), 'Clientes');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
            { Nome: 'Bruno', Telefone: '11999990002' },
        ]), 'Reativacao');
        XLSX.writeFile(workbook, filePath);

        const rows = await readSpreadsheetRows(filePath);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((row) => row.__aba), ['Clientes', 'Reativacao']);
        assert.deepEqual(rows.map((row) => row.Nome), ['Ana', 'Bruno']);

        const [aiSource] = await loadSpreadsheetSources(temporaryDirectory);
        assert.equal(aiSource.name, 'base.xlsx');
        assert.equal(aiSource.rows.length, 2);
        assert.match(aiSource.signature, /^[a-f0-9]{64}$/);
    } finally {
        clearSpreadsheetCache();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});
