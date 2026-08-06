const readline = require('readline');
const whatsapp = require('./core/whatsapp');
const excel = require('./core/excel');
const sender = require('./core/sender');
const report = require('./core/report');
const fs = require('fs');
const path = require('path');

function encontrarPlanilhaPadrao() {
    const pastaListas = path.join(__dirname, 'listas');

    if (!fs.existsSync(pastaListas)) {
        return null;
    }

    const arquivos = fs.readdirSync(pastaListas)
        .filter(nome => nome.toLowerCase().endsWith('.xlsx'))
        .sort((a, b) => b.localeCompare(a));

    if (arquivos.length === 0) {
        return null;
    }

    return path.join(pastaListas, arquivos[0]);
}

async function gerarRelatorioTxt(resultados) {
    const now = new Date();
    const fileName = `relatorio_envio_${now.toISOString().replace(/[:.]/g,'-')}.txt`;
    const filePath = path.join(__dirname, 'reports', fileName);

    // Clientes sem número (não têm telefoneValido)
    const semNumeroObjs = resultados.filter(r => !r.telefoneValido).map(r => ({ nome: r.nome, status: r.statusEnvio || 'Sem número' }));

    // Falharam no envio (têm número mas não foram enviados)
    const falharam = resultados.filter(r => r.telefoneValido && r.statusEnvio !== 'Enviado')
        .map(r => ({ nome: r.nome, telefone: r.telefoneOriginal || r.telefoneValido || '', status: r.statusEnvio }));

    // Enviados com sucesso
    const enviados = resultados.filter(r => r.statusEnvio === 'Enviado')
        .map(r => ({ nome: r.nome, telefone: r.telefoneOriginal || r.telefoneValido || '' }));

    const lines = [];
    lines.push(`Relatório de envio - ${now.toLocaleString()}`);
    lines.push('');
    lines.push('Clientes SEM NÚMERO (para cobrança manual):');
    if (semNumeroObjs.length === 0) {
        lines.push('- Nenhum');
    } else {
        semNumeroObjs.forEach(n => lines.push(`- ${n.nome}  |  ${n.status}`));
    }

    lines.push('');
    lines.push('Envios que falharam:');
    if (falharam.length === 0) {
        lines.push('- Nenhum');
    } else {
        falharam.forEach(f => lines.push(`- ${f.nome}  |  ${f.telefone}  |  ${f.status}`));
    }

    lines.push('');
    lines.push('Envios ENVIADOS com sucesso:');
    if (enviados.length === 0) {
        lines.push('- Nenhum');
    } else {
        enviados.forEach(e => lines.push(`- ${e.nome}  |  ${e.telefone}`));
    }

    // garante pasta reports
    try {
        if (!fs.existsSync(path.join(__dirname, 'reports'))) fs.mkdirSync(path.join(__dirname, 'reports'));
        fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
    } catch (e) {
        throw e;
    }

    return filePath;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const state = {
    clientes: [],
    arquivoAtual: encontrarPlanilhaPadrao() || "Lista-fiado-05-08-26 1413.xlsx",
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
    if (comTelefone > 0) {
        console.log('\nExemplo de clientes com telefone (até 10):');
        state.clientes.filter(c => c.telefoneValido).slice(0,10).forEach(c => {
            console.log(`- ${c.nome}  |  ${c.telefoneValido.replace('@c.us','')}`);
        });
    }
    
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
                if(nome) {
                    const caminhoInformado = path.join(__dirname, 'listas', nome);
                    state.arquivoAtual = fs.existsSync(caminhoInformado) ? caminhoInformado : nome;
                }
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

            const comTel = state.clientes.filter(c => c.telefoneValido).length;
            const semTel = state.clientes.length - comTel;
            console.log(`\nPreparando envios: ${comTel} com telefone | ${semTel} sem telefone`);

            console.log("\nIniciando envios...");
            state.relatorioStatus = await sender.enviarMensagens(state.clientes, whatsapp.getClient());
            console.log("\nEnvios finalizados!");

            try {
                await gerarRelatorioTxt(state.relatorioStatus);
                console.log('Relatório TXT gerado em /reports');
            } catch (e) {
                console.log('Erro ao gerar relatório TXT:', e.message);
            }
            try {
                const csvPath = await report.gerarCSV(state.relatorioStatus);
                console.log('Relatório CSV gerado em', csvPath);
            } catch (e) {
                console.log('Erro ao gerar CSV:', e.message);
            }

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
        if(state.arquivoAtual && fs.existsSync(state.arquivoAtual)) {
            state.clientes = excel.lerPlanilha(state.arquivoAtual);
        } else {
            const padrao = encontrarPlanilhaPadrao();
            if(padrao) {
                state.arquivoAtual = padrao;
                state.clientes = excel.lerPlanilha(padrao);
            }
        }
    } catch(e) {}
    showMenu();
});

// Atualiza o menu quando o WhatsApp conectar
whatsapp.onReady(() => {
    showMenu();
});
