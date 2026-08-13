const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    CONSUMER_BACKUP_EXTENSIONS,
    DOCUMENT_EXTENSIONS,
    classifyDataFile,
    dataFileFormat,
    importDocumentDataFile,
    downloadGoogleDriveDataFile,
    removeDownloadedDataFile,
} = require('../core/data-import');
const { inferListKind, parseImportFile } = require('../core/importer');

test('classifica backup Firebird e documentos sem depender de caminho padrao', () => {
    for (const extension of CONSUMER_BACKUP_EXTENSIONS) {
        assert.equal(classifyDataFile(`C:\\escolhido\\backup${extension}`).kind, 'consumer-backup');
    }
    for (const extension of DOCUMENT_EXTENSIONS) {
        assert.equal(classifyDataFile(`/escolhido/tabela${extension}`).kind, 'document');
    }
    assert.throws(() => classifyDataFile('arquivo.exe'), { code: 'DATA_FILE_UNSUPPORTED' });
    for (const extension of CONSUMER_BACKUP_EXTENSIONS) {
        assert.equal(dataFileFormat(`backup${extension}`), extension.slice(1).toUpperCase());
    }
});

test('identifica produtos por cabecalhos comuns e nao adivinha tabela ambigua', () => {
    assert.equal(inferListKind('dados.csv', [{ Código: '123', Nome: 'Banana', Venda: '5,00' }]), 'produtos');
    assert.equal(inferListKind('dados.csv', [{ Nome: 'Ana', Telefone: '11999990001' }]), 'clientes');
    assert.equal(inferListKind('dados.csv', [{ Nome: 'Ana', Saldo: '25,00' }]), 'devedores');
    assert.equal(inferListKind('dados.csv', [{ Nome: 'Registro', Valor: '25,00' }]), null);
    assert.equal(inferListKind('clientes.csv', [{ Código: '123', Nome: 'Banana', Venda: '5,00' }]), null);
});

test('parser do CLI preserva tabela de produtos sem converte-la em clientes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-product-csv-'));
    const filePath = path.join(directory, 'dados.csv');
    fs.writeFileSync(filePath, 'Codigo;Nome;Venda\n123;Banana;5,00', 'utf8');
    try {
        const parsed = await parseImportFile(filePath);
        assert.equal(parsed.tipo, 'produtos');
        assert.equal(parsed.rows.length, 1);
        assert.deepEqual(parsed.clientes, []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('importacao unificada rejeita tipo ambiguo sem gravar como cliente', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-data-ambiguous-'));
    const filePath = path.join(directory, 'dados.csv');
    fs.writeFileSync(filePath, 'Nome,Valor\nRegistro,25');
    let writes = 0;
    try {
        await assert.rejects(
            importDocumentDataFile(filePath, {
                importer: {
                    readImportRows: async () => ({ extension: '.csv', rows: [{ Nome: 'Registro', Valor: '25' }] }),
                    inferListKind: () => null,
                },
                database: {
                    importProducts: () => { writes += 1; },
                    importCustomers: () => { writes += 1; },
                },
            }),
            { code: 'DATA_KIND_AMBIGUOUS' },
        );
        assert.equal(writes, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('documento usa inferencia existente, roteia produtos e salva somente nome no metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-data-import-'));
    const filePath = path.join(directory, 'arquivo-temporario.csv');
    const sourceName = 'estoque-exportado-do-drive.csv';
    fs.writeFileSync(filePath, 'conteudo-sintetico');
    const calls = [];
    try {
        const result = await importDocumentDataFile(filePath, {
            sourceKind: 'drive-file',
            sourceName,
            importer: {
                readImportRows: async () => ({ extension: '.csv', rows: [{ Produto: 'Item' }] }),
                inferListKind: (source) => {
                    calls.push({ method: 'infer', source });
                    return 'produtos';
                },
            },
            database: {
                importProducts: (rows, source) => {
                    calls.push({ method: 'products', rows, source });
                    return { created: 1, updated: 0, ignored: 0 };
                },
                importCustomers: () => assert.fail('nao deve importar produto como cliente'),
                saveImportMetadata: (metadata) => {
                    calls.push({ method: 'metadata', metadata });
                    return metadata;
                },
            },
        });
        assert.equal(result.tipoImportacao, 'produtos');
        assert.equal(result.tipoFonte, 'drive-file');
        assert.equal(result.arquivo, sourceName);
        assert.equal(calls.find((call) => call.method === 'infer').source, sourceName);
        assert.equal(calls.find((call) => call.method === 'products').source, sourceName);
        assert.equal(calls.find((call) => call.method === 'metadata').metadata.arquivo, sourceName);
        assert.equal(calls.find((call) => call.method === 'metadata').metadata.arquivo.includes(directory), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('download do Drive exige nome suportado, preserva extensao e permite limpeza', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-data-drive-test-'));
    try {
        const downloaded = await downloadGoogleDriveDataFile(
            'https://drive.google.com/file/d/arquivo-drive-12345/view',
            {
                tempRoot: directory,
                downloader: async (_url, destination) => {
                    fs.writeFileSync(destination, 'planilha');
                    return {
                        fileId: 'arquivo-drive-12345',
                        fileName: '..\\clientes.xlsx',
                        sizeBytes: 8,
                    };
                },
            },
        );
        assert.equal(downloaded.fileName, 'clientes.xlsx');
        assert.equal(path.basename(downloaded.filePath), 'clientes.xlsx');
        assert.equal(path.extname(downloaded.filePath), '.xlsx');
        assert.equal(fs.existsSync(downloaded.filePath), true);
        await removeDownloadedDataFile(downloaded);
        assert.equal(fs.existsSync(downloaded.temporaryDirectory), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('download do Drive rejeita nome ausente ou extensao nao suportada e limpa temporarios', async (t) => {
    const cases = [
        { name: 'sem Content-Disposition ou nome', fileName: undefined },
        { name: 'com extensao nao suportada', fileName: 'arquivo-executavel.exe' },
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valeverde-data-drive-invalid-'));
            try {
                await assert.rejects(
                    downloadGoogleDriveDataFile(
                        'https://drive.google.com/file/d/arquivo-drive-invalido-12345/view',
                        {
                            tempRoot: directory,
                            downloader: async (_url, destination) => {
                                fs.writeFileSync(destination, 'conteudo-que-deve-ser-removido');
                                return {
                                    fileId: 'arquivo-drive-invalido-12345',
                                    fileName: scenario.fileName,
                                    sizeBytes: 30,
                                };
                            },
                        },
                    ),
                    (error) => {
                        assert.equal(error?.name, 'DataImportError');
                        assert.equal(error?.code, 'DATA_FILE_UNSUPPORTED');
                        assert.match(error?.message || '', /Formato nao suportado/i);
                        return true;
                    },
                );
                assert.deepEqual(fs.readdirSync(directory), []);
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }
});

test('preload expoe contrato unificado e main nao preenche URL ou pasta real', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    assert.match(preload, /importDataFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('data-import:select-file'\)/);
    assert.match(preload, /importDataFromUrl:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\('data-import:from-url'/);
    assert.match(preload, /removeConsumerBackupFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('consumer-backup:remove-folder'\)/);
    assert.match(main, /extensions:\s*\['fb', 'fbconsumer', 'fbk', 'gbk', 'bak', 'backup', 'pdf', 'xls', 'xlsx', 'csv'\]/);
    assert.doesNotMatch(main, /usp=(?:sharing|drive_link)/);
    assert.doesNotMatch(main, /synchronizeLists\(\);/);
    assert.doesNotMatch(main, /loadSpreadsheetSources\(listSync\.LISTS_DIR/);
    assert.doesNotMatch(main, /ipcMain\.handle\('(?:lists:sync|customers:import|consumer-backup:import-file|consumer-backup:import-url|consumer-backup:sync-folder)'/);
    assert.doesNotMatch(preload, /(?:syncLists|importCustomers|importConsumerBackup|importConsumerBackupFromUrl|syncConsumerBackupFolder):/);
});

test('Electron e CLI nao varrem nem completam caminhos na pasta listas', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    const cli = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard.ps1'), 'utf8');
    for (const source of [main, cli, launcher]) {
        assert.doesNotMatch(source, /VALEVERDE_LISTS_DIR|path\.join\([^\n]*['"]listas['"]|synchronizeLists|sync-lists/);
    }
    assert.doesNotMatch(cli, /encontrarTabelaPadrao|carregarTabela\(state\.arquivoAtual\)/);
    assert.doesNotMatch(cli, /:\s*state\.arquivoAtual\s*;/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'core', 'sync-lists.js')), false);
});

test('atalho do repositorio abre o codigo atual antes de recorrer ao pacote compilado', () => {
    const launcher = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard.ps1'), 'utf8');
    const electronBranch = launcher.indexOf('if (Test-Path $electronExe)');
    const compiledBranch = launcher.indexOf('if ($compiledApp)');
    assert.ok(electronBranch >= 0, 'o launcher precisa localizar o Electron do repositorio');
    assert.ok(compiledBranch >= 0, 'o launcher precisa manter o pacote como alternativa');
    assert.ok(electronBranch < compiledBranch, 'o codigo-fonte atual precisa ter prioridade sobre dist');
});
