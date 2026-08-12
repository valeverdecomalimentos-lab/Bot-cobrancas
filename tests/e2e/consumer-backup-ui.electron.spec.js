const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function prepareSandbox(testInfo) {
    const root = testInfo.outputPath('sandbox');
    const paths = {
        data: path.join(root, 'data'),
        reports: path.join(root, 'reports'),
        templates: path.join(root, 'templates'),
        auth: path.join(root, 'whatsapp-auth'),
        lists: path.join(root, 'listas'),
    };
    Object.values(paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    fs.writeFileSync(path.join(paths.data, 'valeverde-db.json'), JSON.stringify({
        version: 3,
        clientes: [{ id: 'cli-1', nome: 'Ana Martins', telefone: '5511999990001', saldo_devedor: 320.5, status: 'devedor' }],
        produtos: [],
        relatorios: [],
        importacoes: [],
        configuracoes: {},
        ia: { conversa: [], relatorio: '', diagnostico: '' },
    }), 'utf8');
    return paths;
}

async function installMockBackupIpc(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
        const calls = { local: 0, urls: [] };
        globalThis.__valeverdeBackupUiTest = calls;

        ipcMain.removeHandler('consumer-backup:import-file');
        ipcMain.removeHandler('consumer-backup:import-url');
        ipcMain.handle('consumer-backup:import-file', async (event) => {
            calls.local += 1;
            event.sender.send('consumer-backup:progress', {
                etapa: 'restauracao',
                mensagem: 'Restaurando uma cópia temporária…',
                percentual: 45,
            });
            await new Promise((resolve) => setTimeout(resolve, 90));
            return {
                cancelado: false,
                arquivo: 'BkpManual_teste.fbconsumer',
                resumo: { clientes: 119, pedidos: 441, itens: 1394, pagamentos: 137, produtos: 163 },
            };
        });
        ipcMain.handle('consumer-backup:import-url', async (event, input = {}) => {
            calls.urls.push(input);
            event.sender.send('consumer-backup:progress', {
                etapa: 'download',
                mensagem: 'Baixando o backup do Google Drive…',
                percentual: 25,
            });
            await new Promise((resolve) => setTimeout(resolve, 120));
            return {
                cancelado: false,
                arquivo: 'BkpManual_drive.fbconsumer',
                origem: 'google-drive',
                resumo: { clientes: 137, pedidos: 1592, itens: 4901, pagamentos: 1325, produtos: 163, entregas: 42 },
                avisos: ['1.151 pedidos não possuem cliente identificado.'],
            };
        });
    });
}

test('modal importa backup local ou link de arquivo do Google Drive', async ({}, testInfo) => {
    const sandbox = prepareSandbox(testInfo);
    const electronEnvironment = { ...process.env };
    delete electronEnvironment.ELECTRON_RUN_AS_NODE;
    const electronApp = await electron.launch({
        executablePath: require('electron'),
        args: [path.join(PROJECT_ROOT, 'electron-main.js')],
        cwd: PROJECT_ROOT,
        env: {
            ...electronEnvironment,
            VALEVERDE_DATA_DIR: sandbox.data,
            VALEVERDE_REPORTS_DIR: sandbox.reports,
            VALEVERDE_TEMPLATES_DIR: sandbox.templates,
            VALEVERDE_AUTH_DIR: sandbox.auth,
            VALEVERDE_LISTS_DIR: sandbox.lists,
        },
    });

    try {
        await installMockBackupIpc(electronApp);
        const page = await electronApp.firstWindow();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.getByRole('button', { name: 'Acessar painel' }).click();
        await page.getByRole('button', { name: 'Clientes', exact: true }).click();
        await page.getByRole('button', { name: /Importar dados/i }).click();

        const dialog = page.getByRole('dialog', { name: 'Importar dados de clientes' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('heading', { name: 'Backup do Consumer' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: /Selecionar tabela/i })).toBeVisible();

        const linkInput = dialog.getByLabel('Link do arquivo no Google Drive');
        await linkInput.fill('https://drive.google.com/drive/folders/pasta-compartilhada');
        await dialog.getByRole('button', { name: 'Importar link' }).click();
        await expect(dialog.getByRole('alert')).toContainText('link de uma pasta');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.urls.length)).toBe(0);

        const backupUrl = 'https://drive.google.com/file/d/arquivo-backup-123/view?usp=sharing';
        await linkInput.fill(backupUrl);
        await dialog.getByRole('button', { name: 'Importar link' }).click();
        await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
        await expect(dialog.getByText('Baixando o backup do Google Drive…')).toBeVisible();
        await expect(dialog.getByText('Backup importado com sucesso')).toBeVisible();
        await expect(dialog.locator('#resultado-importacao')).toContainText('1.592');
        await expect(dialog.locator('#resultado-importacao')).toContainText('4.901');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.urls)).toEqual([{ url: backupUrl }]);

        await dialog.getByRole('button', { name: /Selecionar backup \.fbconsumer/i }).click();
        await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
        await expect(dialog.locator('#resultado-importacao')).toContainText('BkpManual_teste.fbconsumer');
        await expect(dialog.locator('#resultado-importacao')).toContainText('441');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.local)).toBe(1);

        await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
        await expect(dialog).toHaveCount(0);
    } finally {
        await electronApp.close();
    }
});
