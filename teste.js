const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const excel = require('./core/excel');
const message = require('./core/message');
const report = require('./core/report');
const config = require('./config');
const qrweb = require('./core/qrweb');

const TARGET_NUMBER_RAW = '22999055666';
const LISTAS_DIR = path.join(__dirname, 'listas');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'cobranca.txt');
const AUTH_CLIENT_ID = 'teste-send-monolito';

function encontrarPlanilha() {
    if (!fs.existsSync(LISTAS_DIR)) return null;
    const arquivos = fs.readdirSync(LISTAS_DIR)
        .filter(nome => nome.toLowerCase().endsWith('.xlsx'))
        .sort((a, b) => b.localeCompare(a));
    if (arquivos.length === 0) return null;
    return path.join(LISTAS_DIR, arquivos[0]);
}

function formatNumberToJid(raw) {
    if (!raw) throw new Error('Número inválido');
    const digits = String(raw).replace(/\D/g, '');
    let num = digits;
    if (num.length === 10 || num.length === 11) num = '55' + num;
    num = num.replace(/^0+/, '');
    return `${num}@c.us`;
}

function isDevedor(status) {
    if (!status) return true;
    const texto = String(status).toLowerCase();
    return /dev|inadimplente|pendente|em aberto|aberto|vencido|não pago|nao pago|devedor/.test(texto);
}

function lerTemplate(caminho) {
    try {
        return fs.readFileSync(caminho, 'utf8');
    } catch (err) {
        return 'Olá, {{nome}}! Seu saldo é R$ {{valor}}.';
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function confirmarPergunta(pergunta) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(pergunta, answer => {
            rl.close();
            resolve(String(answer || 's').trim().toLowerCase().startsWith('s'));
        });
    });
}

function gerarResumo(clientes) {
    const resumo = {
        total: clientes.length,
        validos: 0,
        semTelefone: 0,
        ignoradosNaoDevedor: 0,
        mensagens: []
    };

    clientes.forEach(cliente => {
        const ehDevedor = isDevedor(cliente.status);
        const valido = !!cliente.telefoneValido && (!config.enviarSomenteDevedores || ehDevedor);

        if (!cliente.telefoneValido) resumo.semTelefone += 1;
        if (!ehDevedor && config.enviarSomenteDevedores) resumo.ignoradosNaoDevedor += 1;
        if (valido) resumo.validos += 1;

        resumo.mensagens.push({
            nome: cliente.nome,
            telefoneOriginal: cliente.telefoneOriginal || '',
            telefoneValido: cliente.telefoneValido || '',
            valor: cliente.valor,
            status: cliente.status,
            devedor: ehDevedor,
            enviavel: valido
        });
    });

    return resumo;
}

async function main() {
    const template = lerTemplate(TEMPLATE_PATH);
    const planilha = encontrarPlanilha();
    if (!planilha) {
        throw new Error('Nenhuma planilha .xlsx encontrada na pasta listas');
    }

    const clientes = excel.lerPlanilha(planilha);
    const resumo = gerarResumo(clientes);

    console.log(`\nPlanilha: ${planilha}`);
    console.log(`Total de clientes: ${resumo.total}`);
    console.log(`Clientes com telefone válido: ${resumo.validos}`);
    console.log(`Clientes sem telefone válido: ${resumo.semTelefone}`);
    if (config.enviarSomenteDevedores) {
        console.log(`Clientes ignorados por não serem devedores: ${resumo.ignoradosNaoDevedor}`);
    }

    console.log('\nPrimeiros 10 registros para validação:');
    resumo.mensagens.slice(0, 10).forEach((item, idx) => {
        console.log(`\n[${idx + 1}] ${item.nome}`);
        console.log(`  Telefone original: ${item.telefoneOriginal || '---'}`);
        console.log(`  Telefone válido: ${item.telefoneValido || '---'}`);
        console.log(`  Valor: ${item.valor}`);
        console.log(`  Status original: ${item.status}`);
        console.log(`  Enviável: ${item.enviavel ? 'SIM' : 'NÃO'}`);
        const mensagem = message.montar({
            nome: item.nome,
            valor: item.valor,
            numero: item.telefoneOriginal
        });
        console.log(`  Mensagem de teste:\n${mensagem.replace(/\n/g, '\n    ')}`);
    });

    const enviarTeste = await confirmarPergunta('\nDeseja enviar estas mensagens de teste para o número de validação? (S/n) ');
    if (!enviarTeste) {
        console.log('Teste abortado pelo usuário.');
        process.exit(0);
    }

    const targetJid = formatNumberToJid(TARGET_NUMBER_RAW);
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: AUTH_CLIENT_ID }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', qr => {
        console.log('\nQR recebido — escaneie com o WhatsApp do celular:');
        qrcode.generate(qr, { small: true });
        try {
            qrweb.setQr(qr);
            qrweb.startServer();
            qrweb.openBrowser();
        } catch (err) {
            console.log('Não foi possível abrir a página web do QR Code:', err.message);
        }
    });

    client.on('ready', async () => {
        console.log('\nCliente pronto. Iniciando envio de teste para', TARGET_NUMBER_RAW);

        try {
            const isReg = await client.isRegisteredUser(targetJid);
            if (!isReg) {
                console.error('Número de teste não registrado no WhatsApp:', TARGET_NUMBER_RAW);
                return process.exit(1);
            }

            const clientesParaTeste = resumo.mensagens.filter(item => item.enviavel);
            for (let i = 0; i < clientesParaTeste.length; i++) {
                const info = clientesParaTeste[i];
                const mensagem = message.montar({
                    nome: info.nome,
                    valor: info.valor,
                    numero: info.telefoneOriginal
                });

                console.log(`\n[${i + 1}/${clientesParaTeste.length}] Enviando mensagem de teste para ${TARGET_NUMBER_RAW}: ${info.nome}`);
                await client.sendMessage(targetJid, mensagem);
                await sleep(1200);
            }

            console.log('\nEnvio de teste concluído para todos os clientes válidos.');

            try {
                const resultados = clientes.map(cliente => {
                    const ehDevedor = isDevedor(cliente.status);
                    const enviavel = !!cliente.telefoneValido && (!config.enviarSomenteDevedores || ehDevedor);
                    return {
                        ...cliente,
                        enviavel,
                        statusEnvio: enviavel ? 'Enviado (teste)' : 'Ignorado'
                    };
                });

                const csvPath = await report.gerarCSV(resultados);
                const txtPath = await report.gerarTXT(resultados);
                console.log('Relatório de teste CSV gerado em', csvPath);
                console.log('Relatório de teste TXT gerado em', txtPath);
            } catch (err) {
                console.error('Erro ao gerar relatório de teste:', err.message);
            }
        } catch (err) {
            console.error('Erro durante o envio:', err.message);
        } finally {
            setTimeout(async () => {
                try { await client.destroy(); } catch(e) {}
                process.exit(0);
            }, 1500);
        }
    });

    client.on('auth_failure', msg => {
        console.error('Falha na autenticação:', msg);
    });

    client.on('disconnected', reason => {
        console.log('Desconectado:', reason);
    });

    await client.initialize();
}

main().catch(err => {
    console.error('Erro fatal:', err.message);
    process.exit(1);
});
