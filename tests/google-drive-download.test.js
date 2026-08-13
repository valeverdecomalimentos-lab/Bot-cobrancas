const test = require('node:test');
const assert = require('node:assert/strict');
const { extractGoogleDriveFileId, buildDownloadUrl, responseFileName, responseModifiedAt } = require('../core/google-drive-download');

test('extrai apenas ids de links HTTPS de arquivo do Google Drive', () => {
    assert.equal(
        extractGoogleDriveFileId('https://drive.google.com/file/d/1ArquivoPublicoSinteticoParaTestes00001/view?usp=sharing'),
        '1ArquivoPublicoSinteticoParaTestes00001',
    );
    assert.equal(
        extractGoogleDriveFileId('https://drive.google.com/open?id=1ArquivoPublicoSinteticoParaTestes00001'),
        '1ArquivoPublicoSinteticoParaTestes00001',
    );
    assert.throws(() => extractGoogleDriveFileId('https://drive.google.com/drive/folders/abc123456789'), { code: 'DRIVE_FOLDER_URL' });
    assert.throws(() => extractGoogleDriveFileId('http://drive.google.com/file/d/abc123456789/view'), { code: 'DRIVE_URL_INVALID' });
    assert.throws(() => extractGoogleDriveFileId('https://example.com/file/d/abc123456789/view'), { code: 'DRIVE_URL_INVALID' });
    assert.throws(() => extractGoogleDriveFileId('https://docs.google.com/spreadsheets/d/abc123456789/edit'), { code: 'DRIVE_URL_INVALID' });
});

test('gera endpoint de download sem preservar parametros do link compartilhado', () => {
    const url = buildDownloadUrl('1ArquivoPublicoSinteticoParaTestes00001');
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'drive.usercontent.google.com');
    assert.equal(url.searchParams.get('id'), '1ArquivoPublicoSinteticoParaTestes00001');
    assert.equal(url.searchParams.get('export'), 'download');
});

test('normaliza o nome sugerido pelo Drive sem aceitar caminhos', () => {
    const response = { headers: { get: () => 'attachment; filename="..\\BkpManual_teste.fbconsumer"' } };
    assert.equal(responseFileName(response), 'BkpManual_teste.fbconsumer');
});

test('normaliza Last-Modified para proteger contra regressao de backup sem data no nome', () => {
    const response = { headers: { get: (name) => name === 'last-modified' ? 'Wed, 12 Aug 2026 16:31:49 GMT' : '' } };
    assert.equal(responseModifiedAt(response), '2026-08-12T16:31:49.000Z');
});
