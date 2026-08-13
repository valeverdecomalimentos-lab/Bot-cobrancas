const fs = require('fs');
const path = require('path');
const readline = require('readline');
const whatsapp = require('./core/whatsapp');
const importer = require('./core/importer');
const sender = require('./core/sender');
const report = require('./core/report');
const database = require('./core/database');
const config = require('./config');

const state = {
    clientes: database.listCustomers(),
    arquivoAtual: null,
    relatorioStatus: [],
};

async function carregarTabela(filePath) {
    const parsed = await importer.parseImportFile(filePath);
    const result = parsed.tipo === 'produtos'
        ? database.importProducts(parsed.rows, parsed.arquivo)
        : database.importCustomers(parsed.rows, parsed.arquivo);
    state.clientes = database.listCustomers();
    state.arquivoAtual = filePath;
    return { parsed, result };
}

function mostrarMenu() {
    console.clear();
    console.log('======================================');
    console.log('       VALE VERDE BOT COBRANCA');
    console.log('======================================');
    console.log(`WhatsApp: ${whatsapp.isReady() ? 'Conectado' : 'Aguardando conexao'}`);
    console.log(`Base persistida: ${state.clientes.length} clientes`);
    console.log(`Arquivo atual: ${state.arquivoAtual || 'Nenhum'}`);
    console.log('\n[1] Importar XLS, XLSX, CSV ou PDF');
    console.log('[2] Iniciar envio');
    console.log('[3] Listar relatorios salvos');
    console.log('[4] Sair\n');
    rl.question('Escolha uma opcao: ', tratarOpcao);
}

async function gerarRelatorios(campanha, resultados) {
    const files = await Promise.all([
        report.gerar(resultados),
        report.gerarCSV(resultados),
        report.gerarTXT(resultados),
    ]);
    return database.saveReportMetadata({ campanha, resultados, arquivos: files });
}

async function tratarOpcao(opcao) {
    if (opcao.trim() === '1') {
        rl.question('Digite o caminho ou o nome do arquivo: ', async (nome) => {
            const informado = nome.trim();
            const candidate = informado ? path.resolve(informado) : null;
            try {
                if (!candidate || !fs.existsSync(candidate)) throw new Error('Arquivo nao encontrado.');
                const { parsed, result } = await carregarTabela(candidate);
                console.log(`Importacao ${parsed.formato}: ${result.created} novos, ${result.updated} atualizados, ${result.ignored} ignorados.`);
            } catch (error) {
                console.log(`Erro ao importar: ${error.message}`);
            }
            setTimeout(mostrarMenu, 1800);
        });
        return;
    }

    if (opcao.trim() === '2') {
        if (!whatsapp.isReady()) {
            console.log('Conecte o WhatsApp antes de iniciar o envio.');
            setTimeout(mostrarMenu, 1800);
            return;
        }
        if (!state.clientes.length) {
            console.log('Importe uma tabela antes de iniciar o envio.');
            setTimeout(mostrarMenu, 1800);
            return;
        }
        console.log('[1] Cobranca (devedores a partir de R$ 50,00)');
        console.log('[2] Promocao (todos com telefone)');
        rl.question('Escolha a campanha: ', async (escolha) => {
            const campanha = config.campanhas[escolha.trim()];
            if (!campanha) {
                console.log('Opcao invalida.');
                setTimeout(mostrarMenu, 1500);
                return;
            }
            try {
                state.relatorioStatus = await sender.enviarMensagens(state.clientes, whatsapp.getClient(), campanha, {
                    onProgress: ({ indice, total, cliente, statusEnvio }) => console.log(`${indice}/${total} ${cliente.nome}: ${statusEnvio}`),
                });
                const saved = await gerarRelatorios(campanha, state.relatorioStatus);
                console.log(`Envio concluido. Relatorio salvo: ${saved.id}`);
            } catch (error) {
                console.log(`Erro no envio: ${error.message}`);
            }
            setTimeout(mostrarMenu, 2000);
        });
        return;
    }

    if (opcao.trim() === '3') {
        const reports = database.listReports();
        if (!reports.length) console.log('Nenhum relatorio salvo.');
        reports.slice(0, 20).forEach((item) => console.log(`${item.data} | ${item.tipo} | ${item.total ?? '--'} processados | ${item.id}`));
        setTimeout(mostrarMenu, 2200);
        return;
    }

    if (opcao.trim() === '4') {
        rl.close();
        process.exit(0);
    }
    mostrarMenu();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('Iniciando WhatsApp. Aguarde o QR Code.');
whatsapp.iniciar().catch((error) => console.log(`Falha ao iniciar WhatsApp: ${error.message}`));

mostrarMenu();

whatsapp.onReady(mostrarMenu);
