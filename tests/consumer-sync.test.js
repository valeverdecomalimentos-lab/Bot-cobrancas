const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_SYNC_INTERVAL_MINUTES,
    ConsumerBackupSyncError,
    canonicalizeGoogleDriveFolderUrl,
    normalizeConsumerBackupSyncConfig,
    createConsumerBackupSyncService,
} = require('../core/consumer-sync');

const FOLDER_ID = '1PastaPublicaSinteticaParaTestes000001';
const FILE_ID = '1ArquivoPublicoSinteticoParaTestes00001';
const FOLDER_URL = `https://drive.google.com/drive/folders/${FOLDER_ID}`;
const FILE_URL = `https://drive.google.com/file/d/${FILE_ID}/view`;
const HASH = 'a'.repeat(64);

function backupSource(overrides = {}) {
    return {
        sourceType: 'folder',
        folderId: FOLDER_ID,
        fileId: FILE_ID,
        fileName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        modifiedAt: '2026-08-12T17:00:00.000Z',
        backupTimestamp: '2026-08-12T13:32:52-03:00',
        fileUrl: FILE_URL,
        ...overrides,
    };
}

function harness(options = {}) {
    let root = options.config || {};
    const saves = [];
    const imports = [];
    const resolutions = [];
    let clock = options.clock || '2026-08-13T12:00:00.000Z';

    const service = createConsumerBackupSyncService({
        resolveSource: options.resolveSource || (async (url) => {
            resolutions.push(url);
            return backupSource();
        }),
        importBackup: options.importBackup || (async (request) => {
            imports.push(request);
            return {
                status: 'completed',
                importacaoId: 'importacao-1',
                sha256: HASH,
                resumo: { clientes: 142 },
            };
        }),
        getConfig: () => root,
        saveConfig: async (patch) => {
            saves.push(structuredClone(patch));
            root = { ...root, ...patch };
            if (options.saveError) throw options.saveError;
            return root;
        },
        now: () => clock,
        intervalMs: options.intervalMs,
    });

    return {
        service,
        saves,
        imports,
        resolutions,
        get config() { return root; },
        setClock(value) { clock = value; },
    };
}

test('canoniza somente links de pasta e elimina query strings', () => {
    assert.deepEqual(
        canonicalizeGoogleDriveFolderUrl(`${FOLDER_URL}?usp=sharing&resourcekey=segredo`),
        { folderId: FOLDER_ID, folderUrl: FOLDER_URL },
    );
    assert.throws(() => canonicalizeGoogleDriveFolderUrl(FILE_URL), { code: 'DRIVE_FOLDER_URL_REQUIRED' });

    const normalized = normalizeConsumerBackupSyncConfig({
        enabled: true,
        folderUrl: `${FOLDER_URL}?token=nao-guardar`,
        intervalMinutes: 0,
        lastError: 'Falhou em https://exemplo.test/?token=segredo token=outro',
    });
    assert.equal(normalized.folderUrl, FOLDER_URL);
    assert.equal(normalized.intervalMinutes, DEFAULT_SYNC_INTERVAL_MINUTES);
    assert.doesNotMatch(JSON.stringify(normalized), /segredo|outro|token=nao-guardar/);
});

test('salva a pasta canonica, resolve o backup mais novo e importa com metadados completos', async () => {
    const progress = [];
    const setup = harness();
    const sharedUrl = `${FOLDER_URL}?usp=sharing&resourcekey=nao-persistir`;
    const result = await setup.service.sync({
        url: sharedUrl,
        save: true,
        onProgress: (event) => progress.push(event.stage),
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(setup.resolutions, [FOLDER_URL]);
    assert.equal(setup.imports.length, 1);
    assert.deepEqual(setup.imports[0], {
        url: FILE_URL,
        sourceKind: 'drive-folder',
        sourceName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        driveFileId: FILE_ID,
        backupCreatedAt: '2026-08-12T13:32:52-03:00',
        onProgress: setup.imports[0].onProgress,
    });
    assert.equal(typeof setup.imports[0].onProgress, 'function');
    assert.ok(progress.includes('folder-check'));
    assert.ok(progress.includes('folder-download'));

    const saved = setup.config.consumerBackupSync;
    assert.equal(saved.enabled, true);
    assert.equal(saved.folderUrl, FOLDER_URL);
    assert.equal(saved.folderId, FOLDER_ID);
    assert.equal(saved.lastCheckedAt, '2026-08-13T12:00:00.000Z');
    assert.equal(saved.lastSyncedAt, '2026-08-13T12:00:00.000Z');
    assert.equal(saved.lastFileId, FILE_ID);
    assert.equal(saved.lastFileName, 'BkpManual_20260812133252_v16.0.3.fbconsumer');
    assert.equal(saved.lastModifiedAt, '2026-08-12T17:00:00.000Z');
    assert.equal(saved.lastStatus, 'success');
    assert.equal(saved.lastImportId, 'importacao-1');
    assert.equal(saved.lastSha256, HASH);
    assert.equal(saved.lastError, null);
    assert.doesNotMatch(JSON.stringify(setup.config), /resourcekey|nao-persistir/);
});

test('nao baixa novamente o mesmo arquivo e registra up_to_date', async () => {
    const setup = harness({
        config: {
            consumerBackupSync: {
                enabled: true,
                folderUrl: `${FOLDER_URL}?usp=sharing`,
                intervalMinutes: 30,
                lastCheckedAt: '2026-08-12T18:00:00.000Z',
                lastSyncedAt: '2026-08-12T18:00:00.000Z',
                lastFileId: FILE_ID,
                lastFileName: 'backup.fbconsumer',
                lastModifiedAt: '2026-08-12T17:00:00.000Z',
                lastStatus: 'success',
                lastImportId: 'anterior',
                lastSha256: HASH,
            },
        },
    });

    const result = await setup.service.sync();
    assert.equal(result.status, 'up_to_date');
    assert.equal(setup.imports.length, 0);
    assert.equal(setup.config.consumerBackupSync.lastStatus, 'up_to_date');
    assert.equal(setup.config.consumerBackupSync.lastSyncedAt, '2026-08-12T18:00:00.000Z');
    assert.equal(setup.config.consumerBackupSync.lastCheckedAt, '2026-08-13T12:00:00.000Z');
});

test('sem versao remota baixa o mesmo fileId novamente e deixa o SHA decidir', async () => {
    const requests = [];
    const setup = harness({
        config: {
            consumerBackupSync: {
                enabled: true,
                folderUrl: FOLDER_URL,
                lastFileId: FILE_ID,
                lastFileName: 'backup.fbconsumer',
                lastModifiedAt: null,
                lastStatus: 'success',
                lastImportId: 'importacao-anterior',
                lastSha256: HASH,
            },
        },
        resolveSource: async () => backupSource({ modifiedAt: null }),
        importBackup: async (request) => {
            requests.push(request);
            return {
                status: 'duplicate',
                importacaoId: 'importacao-anterior',
                sha256: HASH,
            };
        },
    });

    const result = await setup.service.sync();

    assert.equal(result.status, 'duplicate');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].driveFileId, FILE_ID);
    assert.equal(setup.config.consumerBackupSync.lastStatus, 'duplicate');
});

test('normaliza e persiste os resultados duplicate e older', async (t) => {
    for (const expected of ['duplicate', 'older']) {
        await t.test(expected, async () => {
            const setup = harness({
                config: { consumerBackupSync: { enabled: true, folderUrl: FOLDER_URL } },
                importBackup: async () => ({
                    status: expected,
                    importacaoId: `${expected}-id`,
                    assinatura: HASH,
                }),
            });
            const result = await setup.service.sync();
            assert.equal(result.status, expected);
            assert.equal(setup.config.consumerBackupSync.lastStatus, expected);
            assert.equal(setup.config.consumerBackupSync.lastImportId, `${expected}-id`);
            assert.equal(
                setup.config.consumerBackupSync.lastSyncedAt,
                '2026-08-13T12:00:00.000Z',
            );
        });
    }
});

test('pasta ja configurada persiste erro higienizado sem URL ou token', async () => {
    const setup = harness({
        config: {
            consumerBackupSync: {
                enabled: true,
                folderUrl: FOLDER_URL,
                lastStatus: 'success',
                lastImportId: 'importacao-anterior',
            },
        },
        resolveSource: async () => {
            throw new Error('<html>falha</html> https://drive.google.com/x?token=segredo access_token=outro');
        },
    });

    await assert.rejects(
        setup.service.sync(),
        /falha/,
    );
    const saved = setup.config.consumerBackupSync;
    assert.equal(saved.folderUrl, FOLDER_URL);
    assert.equal(saved.lastImportId, 'importacao-anterior');
    assert.equal(saved.lastStatus, 'error');
    assert.match(saved.lastError, /falha/);
    assert.doesNotMatch(saved.lastError, /<html>|https:\/\/|segredo|outro/);
    assert.doesNotMatch(JSON.stringify(saved), /segredo|outro/);
});

test('primeira configuracao com falha permanece desabilitada e sem URL persistida', async () => {
    const setup = harness({
        resolveSource: async () => {
            throw new Error('pasta nova inacessivel');
        },
    });

    await assert.rejects(
        setup.service.sync({ url: `${FOLDER_URL}?resourcekey=nao-persistir`, save: true }),
        /inacessivel/,
    );
    assert.deepEqual(setup.saves, []);
    assert.equal(setup.config.consumerBackupSync, undefined);
    assert.equal(setup.service.getStatus().enabled, false);
    assert.equal(setup.service.getStatus().folderUrl, null);
    assert.equal(setup.service.getStatus().folderId, null);
});

test('falha ao importar de pasta substituta preserva integralmente a configuracao anterior', async () => {
    const replacementFolderId = '1PastaSubstitutaDrive1234567890';
    const replacementFolderUrl = `https://drive.google.com/drive/folders/${replacementFolderId}`;
    const previous = {
        enabled: true,
        folderUrl: FOLDER_URL,
        intervalMinutes: 45,
        lastCheckedAt: '2026-08-12T10:00:00.000Z',
        lastSyncedAt: '2026-08-12T10:00:00.000Z',
        lastFileId: FILE_ID,
        lastFileName: 'backup-anterior.fbconsumer',
        lastModifiedAt: '2026-08-12T09:00:00.000Z',
        lastStatus: 'success',
        lastImportId: 'importacao-anterior',
        lastSha256: HASH,
        lastError: null,
    };
    const setup = harness({
        config: { consumerBackupSync: previous },
        resolveSource: async () => backupSource({
            folderId: replacementFolderId,
            fileId: '1ArquivoSubstitutoDrive123456789',
            fileUrl: 'https://drive.google.com/file/d/1ArquivoSubstitutoDrive123456789/view',
            modifiedAt: '2026-08-13T11:00:00.000Z',
        }),
        importBackup: async () => {
            throw new Error('backup substituto invalido');
        },
    });

    await assert.rejects(
        setup.service.sync({ url: replacementFolderUrl, save: true }),
        /substituto invalido/,
    );
    assert.deepEqual(setup.saves, []);
    assert.deepEqual(setup.config.consumerBackupSync, previous);
    const status = setup.service.getStatus();
    assert.equal(status.folderUrl, FOLDER_URL);
    assert.equal(status.lastStatus, 'success');
    assert.equal(status.lastError, null);
});

test('execucao automatica concorrente e ignorada, mas a manual recebe erro claro', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const setup = harness({
        resolveSource: async () => {
            await gate;
            return backupSource();
        },
    });

    const first = setup.service.sync({ url: FOLDER_URL, save: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await setup.service.sync({ reason: 'automatic' }), {
        status: 'skipped',
        reason: 'busy',
        message: 'Uma sincronizacao do backup ja esta em andamento.',
    });
    await assert.rejects(setup.service.sync(), (error) => {
        assert.ok(error instanceof ConsumerBackupSyncError);
        assert.equal(error.code, 'SYNC_ALREADY_RUNNING');
        return true;
    });
    release();
    await first;
});

test('start agenda com timer sem referencia, permite checagem imediata e stop cancela', async () => {
    const results = [];
    const setup = harness({
        intervalMs: 60_000,
        config: { consumerBackupSync: { enabled: true, folderUrl: FOLDER_URL, intervalMinutes: 30 } },
    });

    const started = setup.service.start({ onResult: (result) => results.push(result), immediate: true });
    assert.equal(started.started, true);
    assert.equal(started.intervalMs, 60_000);
    assert.equal(started.unrefed, true);
    await started.initialCheck;
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'success');
    assert.equal(setup.service.getStatus().scheduled, true);
    assert.equal(setup.service.stop(), true);
    assert.equal(setup.service.getStatus().scheduled, false);
    assert.equal(setup.service.stop(), false);
});

test('start nao agenda quando a sincronizacao esta desabilitada', async () => {
    const setup = harness();
    const started = setup.service.start();
    assert.deepEqual(
        { started: started.started, reason: started.reason, intervalMs: started.intervalMs },
        { started: false, reason: 'disabled', intervalMs: null },
    );
    assert.equal(await started.initialCheck, null);
});

test('disable remove somente a fonte salva, para o timer e permite configurar outra pasta depois', async () => {
    const otherFolderId = '1OutraPastaPublicaDrive123456789';
    const otherFolderUrl = `https://drive.google.com/drive/folders/${otherFolderId}`;
    let selectedFolderId = FOLDER_ID;
    const setup = harness({
        intervalMs: 60_000,
        config: { consumerBackupSync: { enabled: true, folderUrl: FOLDER_URL, intervalMinutes: 30 } },
        resolveSource: async () => backupSource({ folderId: selectedFolderId }),
    });
    const started = setup.service.start({ immediate: false });
    assert.equal(started.started, true);
    assert.equal(setup.service.getStatus().scheduled, true);

    const disabled = await setup.service.disable();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.folderUrl, null);
    assert.equal(disabled.folderId, null);
    assert.equal(setup.service.getStatus().scheduled, false);
    assert.deepEqual(setup.imports, []);

    selectedFolderId = otherFolderId;
    const result = await setup.service.sync({ url: otherFolderUrl, save: true });
    assert.equal(result.status, 'success');
    assert.equal(setup.service.getStatus().enabled, true);
    assert.equal(setup.service.getStatus().folderUrl, otherFolderUrl);
});
