const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function prepareSandbox(testInfo) {
    const root = testInfo.outputPath('sandbox');
    const paths = {
        root,
        data: path.join(root, 'data'),
        reports: path.join(root, 'reports'),
        templates: path.join(root, 'templates'),
        auth: path.join(root, 'whatsapp-auth'),
        lists: path.join(root, 'listas'),
    };
    Object.values(paths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    fs.writeFileSync(path.join(paths.data, 'valeverde-db.json'), JSON.stringify({
        version: 3,
        clientes: [
            { id: 'cli-1', nome: 'Ana Martins', telefone: '5511999990001', saldo_devedor: 320.5, status: 'devedor' },
            { id: 'cli-2', nome: 'Bruno Lima', telefone: '5511999990002', saldo_devedor: 0, status: 'em_dia' },
            { id: 'cli-3', nome: 'Carla Souza', telefone: '5511999990003', saldo_devedor: 780.9, status: 'devedor' },
        ],
        produtos: [
            { id: 'prod-1', nome: 'Café Especial', codigo: '001', estoque: 4, estoqueMinimo: 10, precoVenda: 24.9 },
            { id: 'prod-2', nome: 'Arroz Integral', codigo: '002', estoque: 35, estoqueMinimo: 8, precoVenda: 12.5 },
        ],
        relatorios: [{ id: 'rel-1', data: new Date().toISOString(), tipo: 'cobranca', total: 24, enviados: 22, erros: 2, ignorados: 0, arquivos: [] }],
        importacoes: [{ id: 'imp-1', data: new Date().toISOString(), arquivo: 'clientes-teste.xlsx', tipo: 'clientes', formato: 'XLSX', status: 'concluida', totalLido: 3 }],
        configuracoes: { intervaloMin: 5, intervaloMax: 11, pix: { nomeFavorecido: 'Vale Verde Teste', chave: 'financeiro@example.com', tipo: 'email' } },
        ia: {
            conversa: [],
            relatorio: '## Resumo seguro\n\n- Prioridade um\n- Prioridade dois\n\n| Indicador | Valor |\n| --- | ---: |\n| Entrega | 92% |\n\n<script>window.__markdownXss = true</script>',
            diagnostico: '',
            atualizadaEm: new Date().toISOString(),
        },
    }, null, 2), 'utf8');
    return paths;
}

async function installMockAiIpc(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
        const providerNames = { gemini: 'Google Gemini', openai: 'OpenAI' };
        const state = {
            activeProvider: 'gemini',
            models: { gemini: 'gemini-3.6-flash', openai: 'gpt-5.6-terra' },
            credentials: {
                gemini: { configured: false, suffix: '' },
                openai: { configured: false, suffix: '' },
            },
        };
        const calls = { status: 0, save: [], remove: [] };

        function publicStatus() {
            const providers = Object.fromEntries(['gemini', 'openai'].map((provider) => {
                const credential = state.credentials[provider];
                const model = state.models[provider];
                const maskedKey = credential.configured ? `••••••••${credential.suffix}` : '';
                return [provider, {
                    configurado: credential.configured,
                    configured: credential.configured,
                    modelo: model,
                    model,
                    chaveMascarada: maskedKey,
                    maskedKey,
                    sufixo: credential.suffix,
                }];
            }));
            const active = providers[state.activeProvider];
            return {
                disponivel: active.configurado,
                provider: state.activeProvider,
                provedor: state.activeProvider,
                provedorNome: providerNames[state.activeProvider],
                model: active.modelo,
                modelo: active.modelo,
                provedores: providers,
                erroConfiguracao: '',
            };
        }

        globalThis.__valeverdeAiTest = { state, calls, publicStatus };
        ipcMain.removeHandler('ai:status');
        ipcMain.removeHandler('ai:settings-save');
        ipcMain.removeHandler('ai:credential-remove');
        ipcMain.handle('ai:status', () => {
            calls.status += 1;
            return publicStatus();
        });
        ipcMain.handle('ai:settings-save', (_event, input = {}) => {
            const provider = input.provider === 'openai' ? 'openai' : 'gemini';
            const apiKey = String(input.apiKey || '');
            if (!apiKey && !state.credentials[provider].configured) {
                throw new Error('Informe uma chave de API.');
            }
            if (apiKey.includes('RejectedByProvider')) {
                throw new Error('Gemini retornou HTTP 403: a API Gemini não está habilitada neste projeto.');
            }
            calls.save.push({
                provider,
                model: String(input.model || ''),
                apiKeyLength: apiKey.length,
                apiKeySuffix: apiKey.slice(-4),
            });
            if (apiKey) {
                state.credentials[provider] = { configured: true, suffix: apiKey.slice(-4) };
            }
            state.models[provider] = String(input.model || state.models[provider]);
            state.activeProvider = provider;
            return publicStatus();
        });
        ipcMain.handle('ai:credential-remove', (_event, providerValue) => {
            const provider = providerValue === 'openai' ? 'openai' : 'gemini';
            calls.remove.push(provider);
            state.credentials[provider] = { configured: false, suffix: '' };
            if (state.activeProvider === provider) {
                state.activeProvider = ['gemini', 'openai'].find((candidate) => state.credentials[candidate].configured)
                    || provider;
            }
            return publicStatus();
        });
    });
}

async function getMockAiCalls(electronApp) {
    return electronApp.evaluate(() => JSON.parse(JSON.stringify(globalThis.__valeverdeAiTest.calls)));
}

test('dashboard e configuracao PIX carregam com dados isolados', async ({}, testInfo) => {
    const sandbox = prepareSandbox(testInfo);
    const packagedExecutable = String(process.env.VALEVERDE_PACKAGED_EXE || '').trim();
    const executablePath = packagedExecutable || require('electron');
    const electronEnvironment = { ...process.env };
    delete electronEnvironment.ELECTRON_RUN_AS_NODE;
    const electronApp = await electron.launch({
        executablePath,
        args: packagedExecutable ? [] : [path.join(PROJECT_ROOT, 'electron-main.js')],
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
        const page = await electronApp.firstWindow();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page).toHaveTitle(/Vale Verde/);
        await page.getByRole('button', { name: /Acessar painel/i }).click();
        await expect(page.getByRole('heading', { name: /operação em um só lugar/i })).toBeVisible();
        await expect(page.getByText('Copiloto Vale Verde')).toBeVisible();
        await expect(page.getByRole('heading', { name: /Conecte a inteligência do painel/i })).toBeVisible();
        await testInfo.attach('dashboard-redesign', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

        await installMockAiIpc(electronApp);
        await page.getByRole('button', { name: 'Configurações', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();

        const geminiRadio = page.getByRole('radio', { name: /Google Gemini/i });
        const openAiRadio = page.getByRole('radio', { name: /OpenAI/i });
        const aiKeyInput = page.getByLabel('Chave de API');
        await expect.poll(async () => (await getMockAiCalls(electronApp)).status).toBeGreaterThanOrEqual(1);
        await expect(geminiRadio).toBeChecked();
        await openAiRadio.check();
        await expect(openAiRadio).toBeChecked();
        await expect(aiKeyInput).toHaveAttribute('type', 'password');

        const openAiSecret = 'sk-proj-e2e-only-openai-secret-9876';
        await aiKeyInput.fill(openAiSecret);
        await page.getByLabel('Modelo', { exact: true }).selectOption('gpt-5.6-luna');
        await page.getByRole('button', { name: /Aplicar e testar conexão/i }).click();
        await expect(page.locator('#status-geral-ia')).toContainText('Copiloto ativo');
        await expect(page.locator('#status-geral-ia')).toContainText('OpenAI');
        await expect(page.locator('#controles-config-ia')).toContainText(/Configurado.*9876/s);
        await expect(aiKeyInput).toHaveValue('');
        await expect(page.locator('body')).not.toContainText(openAiSecret);
        expect(await page.evaluate(
            async (secret) => JSON.stringify(await window.valeverdeAPI.getAiStatus()).includes(secret),
            openAiSecret,
        )).toBe(false);

        let aiCalls = await getMockAiCalls(electronApp);
        expect(aiCalls.save[0]).toEqual({
            provider: 'openai',
            model: 'gpt-5.6-luna',
            apiKeyLength: openAiSecret.length,
            apiKeySuffix: '9876',
        });

        await geminiRadio.check();
        await expect(geminiRadio).toBeChecked();
        await expect(aiKeyInput).toHaveAttribute('type', 'password');
        await aiKeyInput.fill('AQ.FakeCredentialRejectedByProvider123456');
        await page.getByRole('button', { name: /Aplicar e testar conexão/i }).click();
        await expect(page.locator('#erro-chave-ia')).toContainText('Gemini retornou HTTP 403');
        await expect(page.locator('#erro-chave-ia')).not.toContainText('Error invoking remote method');

        const geminiSecret = 'AIzaSyE2EOnlyGeminiSecret1234';
        await aiKeyInput.fill(geminiSecret);
        await page.getByRole('button', { name: /Aplicar e testar conexão/i }).click();
        await expect(page.locator('#status-geral-ia')).toContainText('Google Gemini');
        await expect(page.locator('#controles-config-ia')).toContainText(/Configurado.*1234/s);
        await expect(page.locator('body')).not.toContainText(geminiSecret);

        const removeAiKey = page.getByRole('button', { name: 'Remover chave' });
        let removalConfirmation = '';
        page.once('dialog', async (dialog) => {
            removalConfirmation = dialog.message();
            await dialog.dismiss();
        });
        await removeAiKey.click();
        expect(removalConfirmation).toMatch(/Remover a chave da Google Gemini/i);
        expect((await getMockAiCalls(electronApp)).remove).toEqual([]);

        page.once('dialog', (dialog) => dialog.accept());
        await removeAiKey.click();
        await expect.poll(async () => (await getMockAiCalls(electronApp)).remove).toEqual(['gemini']);
        await expect(page.locator('#controles-config-ia')).toContainText('Nenhuma chave cadastrada');
        await expect(page.locator('#status-geral-ia')).toContainText('OpenAI');
        await expect(page.getByRole('button', { name: 'Remover chave' })).toHaveCount(0);
        aiCalls = await getMockAiCalls(electronApp);
        expect(aiCalls.save.map(({ provider }) => provider)).toEqual(['openai', 'gemini']);

        await page.getByRole('button', { name: 'Painel', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Resumo seguro' })).toBeVisible();
        await expect(page.locator('.conteudo-markdown table')).toBeVisible();
        await expect(page.locator('.conteudo-markdown script')).toHaveCount(0);
        expect(await page.evaluate(() => window.__markdownXss)).toBeUndefined();
        await page.getByRole('button', { name: /Configurações/i }).click();
        await expect(page.getByRole('heading', { name: /Configurações/i })).toBeVisible();

        await expect(page.getByLabel(/Nome do favorecido/i)).toHaveValue('Vale Verde Teste');
        await expect(page.getByLabel(/Chave PIX/i)).toHaveValue('financeiro@example.com');
        await page.getByLabel(/Chave PIX/i).fill('email-invalido');
        await page.getByRole('button', { name: /Salvar configurações/i }).click();
        await expect(page.locator('#erro-pix-chave')).toContainText(/Informe um e-mail válido para a chave PIX/i);
        await page.getByLabel(/Nome do favorecido/i).fill('Vale Verde Operações');
        await page.getByLabel(/Chave PIX/i).fill('pix@example.com');
        await page.getByRole('button', { name: /Salvar configurações/i }).click();
        await expect(page.locator('.toast--sucesso')).toContainText(/Dados PIX e preferências salvos/i);
        const pixPersistido = await page.evaluate(async () => (await window.valeverdeAPI.bootstrap()).configuracoes.pix);
        expect(pixPersistido).toEqual({ nomeFavorecido: 'Vale Verde Operações', chave: 'pix@example.com', tipo: 'email' });
        await testInfo.attach('configuracao-pix', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

        await page.setViewportSize({ width: 390, height: 760 });
        const botaoMenu = page.getByRole('button', { name: 'Abrir menu' });
        await expect(botaoMenu).toBeVisible();
        await expect(page.locator('#barra-lateral')).toHaveAttribute('aria-hidden', 'true');
        await botaoMenu.click();
        await expect(page.locator('#barra-lateral')).toHaveClass(/aberta/);
        await expect(page.locator('#btn-fechar-menu')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#barra-lateral')).toHaveAttribute('aria-hidden', 'true');
        await expect(botaoMenu).toBeFocused();
        await page.evaluate(() => window.scrollTo(0, 0));
        await testInfo.attach('mobile-390', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
        await electronApp.close();
    }
});
