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
        clientes: [
            {
                id: 'cli-1',
                nome: 'Ana Martins',
                telefone: '5511999990001',
                saldo_devedor: 320.5,
                status: 'devedor',
                consumerSourceKey: 'consumer:principal',
                consumerExternalId: 'consumer-ana',
                perfilConsumer: {
                    orderCount: 4,
                    totalPurchasedCents: 45678,
                    averageTicketCents: 11420,
                    firstPurchaseAt: '2026-08-01T10:00:00-03:00',
                    lastPurchaseAt: '2026-08-12T14:30:00-03:00',
                    averageDaysBetweenPurchases: 3.7,
                    paymentCount: 3,
                    paidTotalCents: 33333,
                    lastPaymentAt: '2026-08-12T15:00:00-03:00',
                    currentDebtCents: 12345,
                    paymentMethods: [{ method: 'PIX', count: 2, totalCents: 25000 }],
                    favoriteProducts: [
                        { name: 'Queijo Minas', category: 'Frios', quantityMilli: 4000, totalCents: 20000 },
                        { name: 'Pão de Queijo', category: 'Congelados', quantityMilli: 2500, totalCents: 15000 },
                    ],
                    fulfillment: { delivery: 2, pickup: 1, inStore: 0, other: 0, unknown: 1 },
                    preferredFulfillment: 'delivery',
                    extra: { endereco: 'Rua que não pode aparecer', nascimento: '1990-01-01', raw: 'segredo' },
                },
            },
            { id: 'cli-2', nome: 'Bruno sem histórico', telefone: '5511999990002', saldo_devedor: 0, status: 'em_dia' },
        ],
        produtos: [],
        relatorios: [],
        importacoes: [],
        configuracoes: {
            consumerBackupSync: {
                enabled: true,
                folderUrl: 'https://drive.google.com/drive/folders/pasta-salva-sintetica',
                intervalMinutes: 30,
            },
        },
        ia: { conversa: [], relatorio: '', diagnostico: '' },
    }), 'utf8');
    return paths;
}

async function installMockBackupIpc(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
        const calls = { localFiles: 0, dataUrls: [], removals: 0, profiles: [], profileFailure: false };
        globalThis.__valeverdeBackupUiTest = calls;

        ipcMain.removeHandler('data-import:select-file');
        ipcMain.removeHandler('data-import:from-url');
        ipcMain.removeHandler('consumer-backup:remove-folder');
        ipcMain.removeHandler('consumer-backup:import-file');
        ipcMain.removeHandler('consumer-backup:import-url');
        ipcMain.removeHandler('consumer-backup:sync-folder');
        ipcMain.removeHandler('consumer-profile:get');
        ipcMain.removeHandler('customers:import');
        ipcMain.handle('data-import:select-file', async (event) => {
            calls.localFiles += 1;
            if (calls.localFiles === 1) {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return {
                    cancelado: false,
                    tipoImportacao: 'clientes',
                    tipoFonte: 'local',
                    arquivo: 'clientes.xlsx',
                    formato: 'XLSX',
                    created: 2,
                    updated: 8,
                    totalLido: 10,
                    invalidos: 0,
                };
            }
            if (calls.localFiles === 3) {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return {
                    cancelado: false,
                    tipoImportacao: 'produtos',
                    tipoFonte: 'local',
                    arquivo: 'produtos.pdf',
                    formato: 'PDF',
                    processados: 1,
                    ignorados: 0,
                    erros: 0,
                    totalProdutos: 313,
                };
            }
            event.sender.send('consumer-backup:progress', {
                etapa: 'restauracao',
                mensagem: `Restaurando uma cópia temporária${String.fromCodePoint(0x2026)}`,
                percentual: 45,
            });
            await new Promise((resolve) => setTimeout(resolve, 90));
            return {
                cancelado: false,
                tipoImportacao: 'consumer-backup',
                tipoFonte: 'local',
                arquivo: 'BkpManual_teste.fbconsumer',
                resumo: { clientes: 119, pedidos: 441, itens: 1394, pagamentos: 137, produtos: 163 },
            };
        });
        ipcMain.handle('data-import:from-url', async (event, input = {}) => {
            calls.dataUrls.push(input);
            const pasta = /\/folders\//i.test(String(input.url || ''));
            event.sender.send('consumer-backup:progress', pasta ? {
                etapa: 'listando',
                mensagem: `Localizando o backup mais recente da pasta${String.fromCodePoint(0x2026)}`,
                percentual: 12,
            } : {
                etapa: 'download',
                mensagem: `Baixando o backup do Google Drive${String.fromCodePoint(0x2026)}`,
                percentual: 25,
            });
            await new Promise((resolve) => setTimeout(resolve, 120));
            return pasta ? {
                cancelado: false,
                tipoImportacao: 'consumer-backup',
                tipoFonte: 'drive-folder',
                arquivo: 'BkpManual_mais_recente.fbconsumer',
                pastaSalva: true,
                sincronizadoEm: '2026-08-13T10:30:00-03:00',
                resumo: { clientes: 142, pedidos: 1971, itens: 5505, pagamentos: 1359, produtos: 313 },
            } : {
                cancelado: false,
                tipoImportacao: 'consumer-backup',
                tipoFonte: 'drive-file',
                arquivo: 'BkpManual_drive.fbconsumer',
                resumo: { clientes: 137, pedidos: 1592, itens: 4901, pagamentos: 1325, produtos: 163, entregas: 42 },
                avisos: ['1.151 pedidos nÃ£o possuem cliente identificado.'],
            };
        });
        ipcMain.handle('consumer-backup:remove-folder', async () => {
            calls.removals += 1;
            return {
                removida: true,
                sincronizacao: {
                    enabled: false,
                    folderUrl: '',
                    folderId: '',
                    lastStatus: 'disabled',
                },
            };
        });
        ipcMain.handle('consumer-profile:get', async (_event, input = {}) => {
            calls.profiles.push(input);
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (calls.profileFailure) throw new Error('Falha simulada no histórico.');
            return {
                sourceKey: input.sourceKey,
                externalId: input.externalId,
                name: 'Ana Martins',
                phone: '5511999990001',
                email: 'privado@example.com',
                identifiers: [{ type: 'cpf', value: '123.456.789-00' }],
                address: 'Rua Privada, 123',
                raw: { segredo: 'não renderizar' },
                extra: { nascimento: '1990-01-01' },
                ordersHistory: [
                    {
                        externalId: 'pedido-recente',
                        orderedAt: '2026-08-12T14:30:00-03:00',
                        origin: 'delivery',
                        totalCents: 20800,
                        paymentStatus: 'partial',
                        partialPayment: true,
                        recordedPaidTotalCents: 10000,
                        recordedRemainingCents: 10800,
                        items: [
                            { productName: 'Queijo Especial', category: 'Frios', quantityMilli: 2000, unitPriceCents: 4000, totalCents: 8000, cancelled: false },
                            { productName: 'Pão de Queijo Família', category: 'Congelados', quantityMilli: 3000, unitPriceCents: 4267, totalCents: 12800, cancelled: false },
                        ],
                        historyTruncated: { items: true, payments: false, deliveries: false },
                    },
                    {
                        externalId: 'pedido-antigo',
                        orderedAt: '2026-08-01T10:00:00-03:00',
                        origin: 'loja',
                        totalCents: 5000,
                        paymentStatus: 'paid',
                        recordedPaidTotalCents: 5000,
                        recordedRemainingCents: 0,
                        items: [{ productName: 'Leite Integral', category: 'Laticínios', quantityMilli: 1000, unitPriceCents: 5000, totalCents: 5000, cancelled: false }],
                        historyTruncated: { items: false, payments: false, deliveries: false },
                    },
                ],
                paymentsHistory: [
                    { externalId: 'pagamento-1', paidAt: '2026-08-12T15:00:00-03:00', method: 'PIX', amountCents: 10000, orderExternalId: 'pedido-recente', cancelled: false },
                    { externalId: 'pagamento-avulso', paidAt: '2026-08-05T09:10:00-03:00', method: 'Dinheiro', amountCents: 2500, orderExternalId: null, cancelled: false },
                ],
                ledgerHistory: [
                    { externalId: 'fiado-pagamento', occurredAt: '2026-08-12T15:00:00-03:00', kind: 'payment', description: 'Baixa no crediário', amountCents: -10000, balanceCents: 10800, cancelled: false },
                    { externalId: 'fiado-compra', occurredAt: '2026-08-12T14:30:00-03:00', kind: 'charge', description: 'Venda no fiado', amountCents: 20800, balanceCents: 20800, cancelled: false },
                ],
                historyMeta: {
                    totals: { orders: 7, payments: 2, ledger: 2, items: 18, deliveries: 0 },
                    returned: { orders: 2, payments: 2, ledger: 2, items: 3, deliveries: 0 },
                    truncated: { orders: true, payments: false, ledger: false, items: true, deliveries: false, any: true },
                },
            };
        });
    });
}

test('configurações centraliza tabela, backup local e sincronização do Google Drive', async ({}, testInfo) => {
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
        await installMockBackupIpc(electronApp);
        const page = await electronApp.firstWindow();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.getByRole('button', { name: 'Acessar painel' }).click();
        await page.getByRole('button', { name: 'Clientes', exact: true }).click();

        const botaoPerfil = page.getByRole('button', { name: 'Ver perfil de compras de Ana Martins' });
        await expect(botaoPerfil).toBeVisible();
        await expect(page.getByRole('row', { name: /Bruno sem histórico/i }).getByRole('button', { name: /Ver perfil/i })).toHaveCount(0);
        await botaoPerfil.click();
        const perfil = page.getByRole('dialog', { name: 'Perfil de compras' });
        await expect(perfil).toBeVisible();
        await expect(perfil.getByRole('heading', { name: 'Ana Martins' })).toBeVisible();
        await expect(perfil.getByText('Carregando histórico completo…')).toBeVisible();
        await expect(perfil).toContainText('R$ 456,78');
        await expect(perfil).toContainText('R$ 114,20');
        await expect(perfil).toContainText('3,7 dias');
        await expect(perfil).toContainText('R$ 123,45');
        await expect(perfil).toContainText('PIX');
        await expect(perfil.getByRole('heading', { name: 'Produtos favoritos' })).toBeVisible();
        await expect(perfil.getByRole('heading', { name: 'Categorias favoritas' })).toBeVisible();
        await expect(perfil.getByRole('heading', { name: 'Canais de compra' })).toBeVisible();
        await expect(perfil).toContainText('Desconhecido');

        await expect(perfil.getByRole('heading', { name: 'Histórico de compras' })).toBeVisible();
        await expect(perfil.getByRole('heading', { name: 'Histórico de pagamentos' })).toBeVisible();
        await expect(perfil.getByRole('heading', { name: 'Movimentações do fiado' })).toBeVisible();
        const compras = perfil.locator('.perfil-consumer__historico-lista > li');
        await expect(compras).toHaveCount(2);
        await expect(compras.nth(0)).toContainText('12/08/2026 às 14:30');
        await expect(compras.nth(0)).toContainText('Pagamento parcial');
        await expect(compras.nth(0)).toContainText('R$ 208,00');
        await expect(compras.nth(0)).toContainText('R$ 100,00');
        await expect(compras.nth(0)).toContainText('R$ 108,00');
        await expect(compras.nth(0)).toContainText('Queijo Especial');
        await expect(compras.nth(0)).toContainText('Pão de Queijo Família');
        await expect(compras.nth(1)).toContainText('01/08/2026 às 10:00');
        await expect(perfil.getByLabel('Pagamentos do mais recente para o mais antigo')).toContainText('Sem pedido vinculado');
        await expect(perfil.getByLabel('Pagamentos do mais recente para o mais antigo')).toContainText('Dinheiro');
        await expect(perfil.getByLabel('Movimentações do fiado da mais recente para a mais antiga')).toContainText('Pagamento do fiado');
        await expect(perfil.getByLabel('Movimentações do fiado da mais recente para a mais antiga')).toContainText('Venda no fiado');
        await expect(perfil.getByText('Visualização parcial.', { exact: true })).toBeVisible();
        await expect(perfil).not.toContainText('Rua que não pode aparecer');
        await expect(perfil).not.toContainText('1990-01-01');
        await expect(perfil).not.toContainText('segredo');
        await expect(perfil).not.toContainText('Rua Privada, 123');
        await expect(perfil).not.toContainText('privado@example.com');
        await expect(perfil).not.toContainText('123.456.789-00');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.profiles)).toEqual([
            { sourceKey: 'consumer:principal', externalId: 'consumer-ana' },
        ]);
        await perfil.getByRole('button', { name: 'Fechar', exact: true }).click();

        await electronApp.evaluate(() => {
            globalThis.__valeverdeBackupUiTest.profileFailure = true;
        });
        await botaoPerfil.click();
        const perfilComFalha = page.getByRole('dialog', { name: 'Perfil de compras' });
        await expect(perfilComFalha).toContainText('R$ 456,78');
        await expect(perfilComFalha.getByRole('alert')).toContainText('Não foi possível carregar o histórico completo.');
        await expect(perfilComFalha).toContainText('O resumo acima continua disponível.');
        await perfilComFalha.getByRole('button', { name: 'Fechar', exact: true }).click();
        await expect(page.getByRole('button', { name: /Importar dados/i })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Selecionar backup/i })).toHaveCount(0);

        await page.getByRole('button', { name: 'Produtos', exact: true }).click();
        await expect(page.getByRole('button', { name: /Sincronizar listas|Importar|Selecionar arquivo/i })).toHaveCount(0);

        await page.getByRole('button', { name: 'Configurações', exact: true }).click();
        const fontes = page.getByRole('region', { name: 'Fontes de dados' });
        await expect(fontes).toBeVisible();
        await expect(fontes.getByRole('heading', { name: 'Importar dados' })).toBeVisible();
        await expect(fontes.getByRole('heading', { name: 'Backup do Consumer' })).toHaveCount(0);
        await expect(fontes.getByRole('heading', { name: 'Tabela de clientes' })).toHaveCount(0);
        const botaoArquivoLocal = fontes.getByRole('button', { name: 'Selecionar arquivo local' });
        await expect(botaoArquivoLocal).toBeVisible();
        await expect(fontes).toContainText('FB, FBCONSUMER, FBK, GBK, BAK, BACKUP, PDF, XLS, XLSX e CSV');
        await expect(fontes.getByText('Pasta recomendada', { exact: true })).toBeVisible();

        const linkInput = fontes.getByLabel('Link do arquivo ou da pasta no Google Drive');
        await expect(fontes.locator('#status-sincronizacao-consumer')).toContainText('Pasta do Google Drive configurada');
        await expect(linkInput).toHaveValue('');
        await expect(linkInput).toHaveAttribute('placeholder', 'Cole aqui o link compartilhado');

        const botaoRemoverPasta = fontes.getByRole('button', { name: 'Remover pasta sincronizada' });
        await expect(botaoRemoverPasta).toBeVisible();
        page.once('dialog', async (dialog) => {
            expect(dialog.type()).toBe('confirm');
            expect(dialog.message()).toContain('nenhum cliente, produto, compra ou pagamento já importado será apagado');
            await dialog.accept();
        });
        await botaoRemoverPasta.click();
        await expect(fontes.locator('#status-sincronizacao-consumer')).toContainText('Sincronização automática ainda não configurada');
        await expect(fontes.getByRole('button', { name: 'Remover pasta sincronizada' })).toHaveCount(0);
        await expect(linkInput).toHaveValue('');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.removals)).toBe(1);
        const clientesDepoisDaRemocao = await page.evaluate(() => window.valeverdeAPI.listCustomers());
        expect(clientesDepoisDaRemocao.some((cliente) => cliente.nome === 'Ana Martins')).toBe(true);

        await botaoArquivoLocal.click();
        await expect(fontes.locator('#resultado-importacao')).toContainText('clientes.xlsx');
        await expect(fontes.locator('#resultado-importacao')).toContainText('8');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.localFiles)).toBe(1);

        await botaoArquivoLocal.click();
        await expect(fontes.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
        await expect(fontes.locator('#resultado-importacao')).toContainText('BkpManual_teste.fbconsumer');
        await expect(fontes.locator('#resultado-importacao')).toContainText('441');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.localFiles)).toBe(2);

        await botaoArquivoLocal.click();
        await expect(fontes.locator('#resultado-importacao')).toContainText('Cadastro de produtos atualizado');
        await expect(fontes.locator('#resultado-importacao')).toContainText('produtos.pdf');
        await expect(fontes.locator('#resultado-importacao')).toContainText('313');
        await expect(fontes.locator('#resultado-importacao')).not.toContainText('Base de clientes atualizada');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.localFiles)).toBe(3);

        await linkInput.fill('https://example.com/backup.fbconsumer');
        await fontes.getByRole('button', { name: 'Importar arquivo' }).click();
        await expect(fontes.getByRole('alert')).toContainText('Google Drive');

        await linkInput.fill('https://docs.google.com/spreadsheets/d/arquivo-planilha-12345/edit');
        await fontes.getByRole('button', { name: 'Importar arquivo' }).click();
        await expect(fontes.getByRole('alert')).toContainText('Google Drive');

        const backupUrl = 'https://drive.google.com/file/d/arquivo-backup-123/view?usp=sharing';
        await linkInput.fill(backupUrl);
        await fontes.getByRole('button', { name: 'Importar arquivo' }).click();
        await expect(fontes.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
        await expect(fontes.getByText('Baixando o backup do Google Drive…')).toBeVisible();
        await expect(fontes.getByText('Backup importado com sucesso')).toBeVisible();
        await expect(fontes.locator('#resultado-importacao')).toContainText('1.592');
        await expect(fontes.locator('#resultado-importacao')).toContainText('4.901');
        await expect(linkInput).toHaveValue('');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.dataUrls)).toEqual([{ url: backupUrl }]);

        const folderUrl = 'https://drive.google.com/drive/folders/pasta-compartilhada?usp=sharing';
        await linkInput.fill(folderUrl);
        await expect(fontes.getByRole('button', { name: 'Salvar e sincronizar agora' })).toBeVisible();
        await fontes.getByRole('button', { name: 'Salvar e sincronizar agora' }).click();
        await expect(fontes.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12');
        await expect(fontes.getByText('Localizando o backup mais recente da pasta…')).toBeVisible();
        await expect(fontes.getByText('Pasta sincronizada com sucesso')).toBeVisible();
        await expect(fontes.locator('#status-sincronizacao-consumer')).toContainText('Pasta do Google Drive configurada');
        await expect(fontes.locator('#status-sincronizacao-consumer')).toContainText('13/08/2026');
        await expect(linkInput).toHaveValue('');
        expect(await electronApp.evaluate(() => globalThis.__valeverdeBackupUiTest.dataUrls)).toEqual([
            { url: backupUrl },
            { url: folderUrl },
        ]);
    } finally {
        await electronApp.close();
    }
});
