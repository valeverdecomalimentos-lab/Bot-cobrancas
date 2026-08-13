const test = require('node:test');
const assert = require('node:assert/strict');

const {
    extractGoogleDriveFolderId,
    parseGoogleDriveSourceUrl,
    decodeDriveJsString,
    parseBackupTimestampFromName,
    parsePublicFolderHtml,
    selectNewestBackupFile,
    resolveGoogleDriveBackupSource,
} = require('../core/google-drive-folder');

const FOLDER_ID = '1PastaPublicaSinteticaParaTestes000001';
const FILE_ID = '1ArquivoPublicoSinteticoParaTestes00001';

function item({ id, name, modifiedAt, size = 1024, mimeType = 'application/octet-stream' }) {
    const value = [];
    value[0] = id;
    value[2] = name;
    value[3] = mimeType;
    value[10] = Date.parse(modifiedAt);
    value[13] = size;
    return value;
}

function encodeDriveString(value) {
    return [...value].map((character) => {
        const code = character.codePointAt(0);
        if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
        return `\\u${code.toString(16).padStart(4, '0')}`;
    }).join('');
}

function folderHtml(items, options = {}) {
    const listingState = options.continuation
        ? [[FOLDER_ID, 50, ['estado-opaco'], '~!!~cursor-opaco-do-drive']]
        : [[FOLDER_ID]];
    const payload = JSON.stringify([items, null, null, null, listingState, 1]);
    return `<html><script>window['_DRIVE_ivd'] = '${encodeDriveString(payload)}';</script></html>`;
}

test('distingue links HTTPS de pasta e arquivo do Google Drive', () => {
    assert.deepEqual(
        parseGoogleDriveSourceUrl(`https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`),
        { sourceType: 'folder', folderId: FOLDER_ID },
    );
    assert.equal(
        extractGoogleDriveFolderId(`https://drive.google.com/drive/u/0/folders/${FOLDER_ID}`),
        FOLDER_ID,
    );
    assert.deepEqual(
        parseGoogleDriveSourceUrl(`https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`),
        { sourceType: 'file', fileId: FILE_ID },
    );
    assert.throws(() => parseGoogleDriveSourceUrl(`http://drive.google.com/drive/folders/${FOLDER_ID}`), {
        code: 'DRIVE_URL_INVALID',
    });
    assert.throws(() => parseGoogleDriveSourceUrl(`https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`), {
        code: 'DRIVE_URL_INVALID',
    });
});

test('decodifica escapes do payload sem executar JavaScript', () => {
    assert.equal(decodeDriveJsString('\\x5b\\x22ok\\x22\\x2c\\x22usp\\\\u003ddrive_web\\x22\\x5d'), '["ok","usp\\u003ddrive_web"]');
    assert.deepEqual(JSON.parse(decodeDriveJsString('\\x5b\\x22ok\\x22\\x2c\\x22usp\\\\u003ddrive_web\\x22\\x5d')), ['ok', 'usp=drive_web']);
    assert.throws(() => decodeDriveJsString('\\xZZ'), { code: 'DRIVE_FOLDER_FORMAT_CHANGED' });
});

test('filtra backups Firebird suportados e normaliza os metadados publicos', () => {
    const files = parsePublicFolderHtml(folderHtml([
        item({ id: FILE_ID, name: 'BkpManual_20260812133252_v16.0.3.fbconsumer', modifiedAt: '2026-08-12T17:00:00.000Z', size: 2_700_800 }),
        item({ id: '1ESXG2c7409uLkJSaARA_X-LvDJNoPMww', name: 'quinta-feira.FB', modifiedAt: '2026-08-13T10:00:00.000Z' }),
        item({ id: '1AliasG2c7409uLkJSaARA_X-LvDJNoPMw', name: 'sexta-feira.gbk', modifiedAt: '2026-08-13T11:00:00.000Z' }),
        item({ id: '1DD2oG3Q_8a3nALaeY2A0KFsNDCfvhHxV', name: 'FotoProduto.zip', modifiedAt: '2026-08-13T12:00:00.000Z' }),
        item({ id: '1FolderG2c7409uLkJSaARA_X-LvDJNoPMw', name: 'subpasta.fbconsumer', modifiedAt: '2026-08-14T12:00:00.000Z', mimeType: 'application/vnd.google-apps.folder' }),
    ]));

    assert.equal(files.length, 3);
    assert.deepEqual(files[0], {
        fileId: FILE_ID,
        fileName: 'BkpManual_20260812133252_v16.0.3.fbconsumer',
        modifiedAt: '2026-08-12T17:00:00.000Z',
        sizeBytes: 2_700_800,
        mimeType: 'application/octet-stream',
        backupTimestamp: '2026-08-12T13:32:52-03:00',
        timestampSource: 'filename',
        selectionTimestamp: Date.parse('2026-08-12T13:32:52-03:00'),
        fileUrl: `https://drive.google.com/file/d/${FILE_ID}/view`,
    });
});

test('usa data do nome Bkp e recorre a modifiedTime nos demais nomes', () => {
    const files = parsePublicFolderHtml(folderHtml([
        item({ id: FILE_ID, name: 'BkpManual_20260814120000_v16.fbconsumer', modifiedAt: '2026-08-10T10:00:00.000Z' }),
        item({ id: '1ESXG2c7409uLkJSaARA_X-LvDJNoPMww', name: 'quinta-feira.fbconsumer', modifiedAt: '2026-08-13T23:00:00.000Z' }),
    ]));

    const newest = selectNewestBackupFile(files);
    assert.equal(newest.fileId, FILE_ID);
    assert.equal(newest.timestampSource, 'filename');
    assert.equal(parseBackupTimestampFromName('BkpManual_20260230120000.fbconsumer'), null);
});

test('recusa listagem publica incompleta em vez de escolher entre apenas os primeiros 50 itens', async () => {
    const partialHtml = folderHtml([
        item({ id: FILE_ID, name: 'backup-do-primeiro-lote.fbconsumer', modifiedAt: '2026-08-13T12:00:00.000Z' }),
    ], { continuation: true });

    assert.throws(
        () => parsePublicFolderHtml(partialHtml),
        (error) => {
            assert.equal(error?.code, 'DRIVE_FOLDER_LIST_INCOMPLETE');
            assert.match(error?.message || '', /no maximo 50 itens/i);
            assert.match(error?.message || '', /subpasta/i);
            assert.match(error?.message || '', /link direto/i);
            return true;
        },
    );

    await assert.rejects(
        resolveGoogleDriveBackupSource(`https://drive.google.com/drive/folders/${FOLDER_ID}`, {
            fetchImpl: async () => new Response(partialHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
        }),
        { code: 'DRIVE_FOLDER_LIST_INCOMPLETE' },
    );
});

test('resolve arquivo sem consulta remota e pasta pelo backup mais novo', async () => {
    let requests = 0;
    const fetchImpl = async (url) => {
        requests += 1;
        assert.equal(url.hostname, 'drive.google.com');
        assert.equal(url.pathname, `/drive/folders/${FOLDER_ID}`);
        return new Response(folderHtml([
            item({ id: FILE_ID, name: 'segunda-feira.fbconsumer', modifiedAt: '2026-08-12T12:00:00.000Z' }),
            item({ id: '1ESXG2c7409uLkJSaARA_X-LvDJNoPMww', name: 'quinta-feira.fb', modifiedAt: '2026-08-13T12:00:00.000Z', size: 2048 }),
        ]), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    };

    const direct = await resolveGoogleDriveBackupSource(`https://drive.google.com/file/d/${FILE_ID}/view`, { fetchImpl });
    assert.equal(requests, 0);
    assert.equal(direct.sourceType, 'file');
    assert.equal(direct.fileId, FILE_ID);

    const folder = await resolveGoogleDriveBackupSource(`https://drive.google.com/drive/folders/${FOLDER_ID}`, { fetchImpl });
    assert.equal(requests, 1);
    assert.equal(folder.sourceType, 'folder');
    assert.equal(folder.folderId, FOLDER_ID);
    assert.equal(folder.fileName, 'quinta-feira.fb');
    assert.equal(folder.sizeBytes, 2048);
});

test('falha de forma clara para pasta privada, sem backups ou payload excessivo', async () => {
    assert.throws(() => parsePublicFolderHtml('<html>login</html>'), { code: 'DRIVE_FOLDER_NOT_PUBLIC' });
    assert.throws(() => selectNewestBackupFile([]), { code: 'DRIVE_FOLDER_NO_BACKUPS' });

    await assert.rejects(
        resolveGoogleDriveBackupSource(`https://drive.google.com/drive/folders/${FOLDER_ID}`, {
            maxHtmlBytes: 8,
            fetchImpl: async () => new Response(folderHtml([]), { headers: { 'content-type': 'text/html' } }),
        }),
        { code: 'DRIVE_FOLDER_TOO_LARGE' },
    );
});
