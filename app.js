const readline = require('readline');
const whatsapp = require('./core/whatsapp');
const excel = require('./core/excel');
const sender = require('./core/sender');
const report = require('./core/report');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const state = {
    clientes: [],
    arquivoAtual: "Lista-fiado-05-08-26 1413.xlsx",
    relatorioStatus: []
};

function clearScreen() {
    console.clear();
}

function showMenu() {
    clearScreen();
    console.log("======================================");
    console.log("       VALE VERDE BOT COBRANÇA        ");
    console.log("======================================");
    console.log(`\nStatus WhatsApp: ${whatsapp.isReady() ? '🟢 Conectado' : '🟡 Aguardando/Iniciando...'}`);
    console.log(`\nArquivo selecionado: ${state.arquivoAtual}`);
    
    let comTelefone = state.clientes.filter(c => c.telefoneValido).length;
    let semTelefone = state.clientes.length - comTelefone;
    
    console.log(`Clientes encontrados: ${state.clientes.length}`);
    console.log(`Com telefone: ${comTelefone}`);
    console.log(`Sem telefone: ${semTelefone}`);
    
    console.log("\n[1] Selecionar/Carregar planilha");
    console.log("[2] Iniciar envio");
    console.log("[3] Gerar relatório");
    console.log("[4] Sair\n");
    
    rl.question("Escolha uma opção: ", handleMenu);
}

async function handleMenu(opcao) {
    switch (opcao.trim()) {
        case '1':
            rl.question("Digite o nome do arquivo Excel (ou Enter para o padrão): ", (nome) => {
                if(nome) state.arquivoAtual = nome;
                try {
                    state.clientes = excel.lerPlanilha(state.arquivoAtual);
                    console.log(`\nSucesso! ${state.clientes.length} clientes carregados.`);
                } catch(e) {
                    console.log(`\nErro ao carregar: ${e.message}`);
                }
                setTimeout(showMenu, 2000);
            });
            break;
        case '2':
            if(!whatsapp.isReady()) {
                console.log("WhatsApp não conectado ainda. Aguarde.");
                setTimeout(showMenu, 2000);
                return;
            }
            if(state.clientes.length === 0) {
                console.log("Carregue a planilha primeiro (Opção 1).");
                setTimeout(showMenu, 2000);
                return;
            }
            console.log("\nIniciando envios...");
            state.relatorioStatus = await sender.enviarMensagens(state.clientes, whatsapp.getClient());
            console.log("\nEnvios finalizados!");
            setTimeout(showMenu, 3000);
            break;
        case '3':
            if(state.relatorioStatus.length === 0) {
                console.log("Nenhum envio realizado nesta sessão para gerar relatório.");
            } else {
                await report.gerar(state.relatorioStatus);
                console.log("Relatório gerado na pasta /reports!");
            }
            setTimeout(showMenu, 2000);
            break;
        case '4':
            console.log("Saindo...");
            process.exit(0);
            break;
        default:
            showMenu();
    }
}

// Inicialização
console.log("Iniciando WhatsApp... Aguarde o QR Code.");
whatsapp.iniciar().then(() => {
    // Tenta carregar a planilha padrão se existir
    try {
        if(fs.existsSync(state.arquivoAtual)) {
            state.clientes = excel.lerPlanilha(state.arquivoAtual);
        }
    } catch(e) {}
    showMenu();
});

// Atualiza o menu quando o WhatsApp conectar
whatsapp.onReady(() => {
    showMenu();
});
