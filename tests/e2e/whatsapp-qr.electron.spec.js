const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const QRCode = require('qrcode');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function prepareSandbox(testInfo) {
    const root = testInfo.outputPath('qr-sandbox');
    const paths = {
        data: path.join(root, 'data'),
        reports: path.join(root, 'reports'),
        templates: path.join(root, 'templates'),
        auth: path.join(root, 'whatsapp-auth'),
        lists: path.join(root, 'listas'),
    };
    Object.values(paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    return paths;
}

async function installMockWhatsappIpc(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
        const initialStatus = {
            status: 'desconectado',
            numero: null,
            qrUrl: null,
            qrDataUrl: null,
            erro: null,
        };
        globalThis.__valeverdeQrTest = {
            status: initialStatus,
            calls: { status: 0, reset: 0, start: 0 },
        };
        ipcMain.removeHandler('whatsapp:status');
        ipcMain.removeHandler('whatsapp:reset');
        ipcMain.removeHandler('whatsapp:start');
        ipcMain.handle('whatsapp:status', () => {
            globalThis.__valeverdeQrTest.calls.status += 1;
            return globalThis.__valeverdeQrTest.status;
        });
        ipcMain.handle('whatsapp:reset', () => {
            globalThis.__valeverdeQrTest.calls.reset += 1;
            globalThis.__valeverdeQrTest.status = { ...initialStatus };
            return globalThis.__valeverdeQrTest.status;
        });
        ipcMain.handle('whatsapp:start', () => {
            globalThis.__valeverdeQrTest.calls.start += 1;
            globalThis.__valeverdeQrTest.status = { ...initialStatus, status: 'iniciando' };
            return globalThis.__valeverdeQrTest.status;
        });
    });
}

async function getMockWhatsappCalls(electronApp) {
    return electronApp.evaluate(() => ({ ...globalThis.__valeverdeQrTest.calls }));
}

async function emitWhatsappStatus(electronApp, payload) {
    await electronApp.evaluate(({ BrowserWindow }, status) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window || window.isDestroyed()) throw new Error('Janela principal indisponivel no teste.');
        globalThis.__valeverdeQrTest.status = status;
        window.webContents.send('whatsapp:status', status);
    }, payload);
}

test('renderiza o QR recebido por IPC sem iniciar uma sessao real', async ({}, testInfo) => {
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
        const page = await electronApp.firstWindow();
        await expect(page.getByRole('button', { name: 'Gerar QR Code' })).toBeVisible();
        await installMockWhatsappIpc(electronApp);

        await expect.poll(
            async () => (await getMockWhatsappCalls(electronApp)).status,
            { timeout: 3_500, message: 'A tela deve consultar novamente o status pelo polling.' },
        ).toBeGreaterThanOrEqual(1);

        const qrDataUrl = await QRCode.toDataURL('valeverde-e2e-qr-isolado', { width: 280, margin: 1 });
        await emitWhatsappStatus(electronApp, {
            status: 'aguardando_qr',
            numero: null,
            qrUrl: null,
            qrDataUrl,
            erro: null,
        });

        const qrImage = page.getByRole('img', { name: /QR Code para conectar o WhatsApp/i });
        await expect(qrImage).toBeVisible();
        await expect(qrImage).toHaveAttribute('src', qrDataUrl);
        await expect(page.getByText('Escaneie o QR Code')).toBeVisible();
        await expect.poll(() => qrImage.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

        await emitWhatsappStatus(electronApp, {
            status: 'aguardando_qr',
            numero: null,
            qrUrl: null,
            qrDataUrl: 'https://exemplo.invalid/qr.png',
            erro: null,
        });
        await expect(qrImage).toHaveCount(0);
        await expect(page.getByRole('alert')).toContainText(/formato inv.lido/i);
        const newQrButton = page.locator('#btn-gerar-novo-qr');
        await expect(newQrButton).toBeVisible();

        page.once('dialog', (dialog) => dialog.dismiss());
        await newQrButton.click();
        await expect.poll(async () => (await getMockWhatsappCalls(electronApp)).reset).toBe(0);
        expect((await getMockWhatsappCalls(electronApp)).start).toBe(0);

        page.once('dialog', (dialog) => dialog.accept());
        await newQrButton.click();
        await expect.poll(async () => (await getMockWhatsappCalls(electronApp)).reset).toBe(1);
        await expect.poll(async () => (await getMockWhatsappCalls(electronApp)).start).toBe(1);
        await expect(page.getByText(/Iniciando conex/i)).toBeVisible();

        await emitWhatsappStatus(electronApp, {
            status: 'conectado',
            numero: '+5511999999999',
            qrUrl: null,
            qrDataUrl: null,
            erro: null,
        });
        await expect(page.getByText('WhatsApp conectado')).toBeVisible();
        const enterButton = page.getByRole('button', { name: 'Entrar no painel' });
        await expect(enterButton).toBeVisible();

        await enterButton.click();
        await expect(page).toHaveURL(/#dashboard$/);
        await page.waitForTimeout(100);
        const callsAfterLeavingLogin = (await getMockWhatsappCalls(electronApp)).status;
        await page.waitForTimeout(2_300);
        expect((await getMockWhatsappCalls(electronApp)).status).toBe(callsAfterLeavingLogin);
    } finally {
        await electronApp.close();
    }
});
