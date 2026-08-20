const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = [
    'Olá! {{nome}}',
    'Temos ofertas especiais preparadas para você aqui na Vale Verde.',
].join('\n');
const RENDERED = [
    'Olá! Ana Martins',
    'Temos ofertas especiais preparadas para você aqui na Vale Verde.',
].join('\n');

function prepareSandbox(testInfo) {
    const root = testInfo.outputPath('sandbox');
    const paths = {
        data: path.join(root, 'data'),
        reports: path.join(root, 'reports'),
        templates: path.join(root, 'templates'),
        auth: path.join(root, 'whatsapp-auth'),
    };
    Object.values(paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    fs.writeFileSync(path.join(paths.templates, 'oferta-exata.txt'), TEMPLATE, 'utf8');
    fs.writeFileSync(path.join(paths.data, 'valeverde-db.json'), JSON.stringify({
        version: 3,
        clientes: [
            { id: 'cli-excluido', nome: '*Excluído * Rogerinho ( pedreiro )', telefone: '5511999990001', saldo_devedor: 0, status: 'em_dia' },
            { id: 'cli-ana', nome: 'Ana Martins', telefone: '5511999990002', saldo_devedor: 0, status: 'em_dia' },
        ],
        produtos: [],
        relatorios: [],
        importacoes: [],
        configuracoes: { intervaloMin: 3, intervaloMax: 3 },
        ia: { conversa: [], relatorio: '', diagnostico: '' },
    }), 'utf8');
    return paths;
}

async function installCampaignMocks(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
        const calls = { tests: [], starts: [] };
        globalThis.__campaignMessageTest = calls;
        ipcMain.removeHandler('campaign:test');
        ipcMain.removeHandler('campaign:start');
        ipcMain.handle('campaign:test', (_event, input = {}) => {
            calls.tests.push(JSON.parse(JSON.stringify(input)));
            return { statusEnvio: 'Enviado (teste)', testeId: 'teste-exato' };
        });
        ipcMain.handle('campaign:start', (_event, input = {}) => {
            calls.starts.push(JSON.parse(JSON.stringify(input)));
            return { cancelado: false, processados: input.recipientIds?.length || 0 };
        });
    });
}

async function campaignCalls(electronApp) {
    return electronApp.evaluate(() => JSON.parse(JSON.stringify(globalThis.__campaignMessageTest)));
}

test('template e mensagem personalizada seguem sem prefixo ou rodape e usam o cliente da previa', async ({}, testInfo) => {
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
        },
    });

    try {
        await installCampaignMocks(electronApp);
        const page = await electronApp.firstWindow();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.getByRole('button', { name: /Acessar painel/i }).click();
        await electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.webContents.send('whatsapp:status', {
                status: 'conectado',
                numero: '5511999999999',
            });
        });

        await page.getByRole('button', { name: 'Nova campanha', exact: true }).click();
        await page.getByRole('button', { name: /Promoção/ }).click();
        await page.getByRole('button', { name: /Avançar/ }).click();

        const editor = page.getByLabel('Mensagem', { exact: true });
        await page.getByLabel('Template salvo').selectOption('oferta-exata');
        await expect(editor).toHaveValue(TEMPLATE);
        await expect(page.getByText(/somente este texto.*não adiciona avisos nem rodapés/i)).toBeVisible();
        await page.getByRole('button', { name: /Avançar/ }).click();

        await page.locator('.linha-revisao').filter({ hasText: 'Rogerinho' }).locator('input').uncheck();
        await page.getByRole('button', { name: /Avançar/ }).click();
        await expect(page.locator('.teste-campanha .bolha-whats')).toContainText(RENDERED);
        await expect(page.locator('.teste-campanha .bolha-whats')).not.toContainText('Rogerinho');

        await page.getByLabel('Número de WhatsApp para teste').fill('22999999999');
        await page.getByRole('button', { name: 'Enviar mensagem teste' }).click();
        await expect.poll(async () => (await campaignCalls(electronApp)).tests.length).toBe(1);
        let calls = await campaignCalls(electronApp);
        expect(calls.tests[0]).toEqual({
            telefone: '22999999999',
            mensagem: TEMPLATE,
            templateId: 'oferta-exata',
            mediaPath: '',
            clienteExemploId: 'cli-ana',
        });

        await page.getByRole('button', { name: /Confirmar campanha/ }).click();
        await page.getByRole('button', { name: /Disparar campanha/ }).click();
        await expect.poll(async () => (await campaignCalls(electronApp)).starts.length).toBe(1);
        calls = await campaignCalls(electronApp);
        expect(calls.starts[0].mensagem).toBe(TEMPLATE);
        expect(calls.starts[0].templateId).toBe('oferta-exata');
        expect(calls.starts[0].mediaPath).toBe('');
        expect(calls.starts[0].mediaFileName).toBe('');
        expect(calls.starts[0].recipientIds).toEqual(['cli-ana']);
        expect(calls.starts[0].mensagem).not.toContain('Esta e uma mensagem automatica');
        expect(calls.starts[0].mensagem).not.toContain('Cliente:');
    } finally {
        await electronApp.close();
    }
});
