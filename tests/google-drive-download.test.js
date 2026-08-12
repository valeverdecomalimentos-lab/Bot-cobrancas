const test = require('node:test');
const assert = require('node:assert/strict');
const { extractGoogleDriveFileId, buildDownloadUrl, responseFileName } = require('../core/google-drive-download');

test('extrai apenas ids de links HTTPS de arquivo do Google Drive', () => {
    assert.equal(
        extractGoogleDriveFileId('https://drive.google.com/file/d/11xdu4GrO98eOXPLHS8kpivLnpjr5asdA/view?usp=sharing'),
        '11xdu4GrO98eOXPLHS8kpivLnpjr5asdA',
    );
    assert.equal(
        extractGoogleDriveFileId('https://drive.google.com/open?id=11xdu4GrO98eOXPLHS8kpivLnpjr5asdA'),
        '11xdu4GrO98eOXPLHS8kpivLnpjr5asdA',
    );
    assert.throws(() => extractGoogleDriveFileId('https://drive.google.com/drive/folders/abc123456789'), { code: 'DRIVE_FOLDER_URL' });
    assert.throws(() => extractGoogleDriveFileId('http://drive.google.com/file/d/abc123456789/view'), { code: 'DRIVE_URL_INVALID' });
    assert.throws(() => extractGoogleDriveFileId('https://example.com/file/d/abc123456789/view'), { code: 'DRIVE_URL_INVALID' });
});

test('gera endpoint de download sem preservar parametros do link compartilhado', () => {
    const url = buildDownloadUrl('11xdu4GrO98eOXPLHS8kpivLnpjr5asdA');
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'drive.usercontent.google.com');
    assert.equal(url.searchParams.get('id'), '11xdu4GrO98eOXPLHS8kpivLnpjr5asdA');
    assert.equal(url.searchParams.get('export'), 'download');
});

test('normaliza o nome sugerido pelo Drive sem aceitar caminhos', () => {
    const response = { headers: { get: () => 'attachment; filename="..\\BkpManual_teste.fbconsumer"' } };
    assert.equal(responseFileName(response), 'BkpManual_teste.fbconsumer');
});
