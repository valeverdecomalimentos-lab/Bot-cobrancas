const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const TARGET_NUMBER_RAW = '22999055666';
const LISTAS_DIR = path.join(__dirname, 'listas');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'cobranca.txt');

function encontrarPlanilha() {
    if (!fs.existsSync(LISTAS_DIR)) return null;
    const arquivos = fs.readdirSync(LISTAS_DIR)
        .filter(nome => nome.toLowerCase().endsWith('.xlsx'))
        .sort((a, b) => b.localeCompare(a));
    if (arquivos.length === 0) return null;
    return path.join(LISTAS_DIR, arquivos[0]);
}
const AUTH_CLIENT_ID = 'teste-send-monolito';

function formatNumberToJid(raw) {
    if (!raw) throw new Error('Número inválido');
    const digits = String(raw).replace(/\D/g, '');
    let num = digits;
    if (num.length === 10 || num.length === 11) num = '55' + num;
    num = num.replace(/^0+/, '');
    return `${num}@c.us`;
}

function formatValor(valor) {
    if (valor === undefined || valor === null || valor === '') return '0,00';
    if (typeof valor === 'number') {
        return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    const cleaned = String(valor).replace(/\s/g, '').replace(',', '.');
    const n = Number(cleaned);
    if (!Number.isNaN(n)) {
        return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return String(valor).trim();
}

function stripHtml(text) {
    return String(text).replace(/<[^>]*>/g, ' ');
}

function buscarTelefoneNoTexto(text) {
    if (!text) return null;
    const valor = stripHtml(text);
    const padrao = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4}|\d{11})/g;
    const encontrado = valor.match(padrao);
    return encontrado ? encontrado[0] : null;
}

function lerPlanilha(caminho) {
    if (!fs.existsSync(caminho)) {
        throw new Error(`Arquivo não encontrado: ${caminho}`);
    }
    const workbook = xlsx.readFile(caminho);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    return data.map(row => {
        const keys = Object.keys(row);
        const keyNome = keys.find(k => /nome|cliente/i.test(k));
        const keyTelefone = keys.find(k => /telefone|celular|contato|numero/i.test(k));
        const keyValor = keys.find(k => /valor|saldo|d[íi]vida|divida/i.test(k));

        const nome = keyNome ? String(row[keyNome]).trim() : 'Cliente';
        const telefoneOriginal = keyTelefone ? String(row[keyTelefone]).trim() : buscarTelefoneNoTexto(Object.values(row).join(' '));
        const valor = keyValor ? row[keyValor] : '';

        return {
            nome,
            numero: telefoneOriginal || '',
            valor: formatValor(valor)
        };
    });
}

function montarMensagem(cliente, template) {
    let mensagem = String(template || '').replace(/\{\{nome\}\}/g, cliente.nome)
        .replace(/\{\{valor\}\}/g, cliente.valor)
        .replace(/\{\{numero\}\}/g, cliente.numero || 'não informado');

    if (!template || !template.includes('{{valor}}') || !template.includes('{{nome}}')) {
        mensagem = `Cliente: ${cliente.nome}\nNúmero: ${cliente.numero || 'não informado'}\nValor: R$ ${cliente.valor}`;
    }

    if (!template.includes('{{numero}}')) {
        mensagem += `\n\nCliente: ${cliente.nome} \nNúmero: ${cliente.numero || 'não informado'} \nValor: R$ ${cliente.valor}`;
    }

    return mensagem;
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

async function main() {
    const template = lerTemplate(TEMPLATE_PATH);
    const planilha = encontrarPlanilha();
    if (!planilha) {
        throw new Error('Nenhuma planilha .xlsx encontrada na pasta listas');
    }
    const clientes = lerPlanilha(planilha);
    const targetJid = formatNumberToJid(TARGET_NUMBER_RAW);

    console.log(`Carregados ${clientes.length} clientes de ${planilha}`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: AUTH_CLIENT_ID }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', qr => {
        console.log('\nQR recebido — escaneie com o WhatsApp do celular:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        console.log('\nCliente pronto. Iniciando envio de teste para', TARGET_NUMBER_RAW);

        try {
            const isReg = await client.isRegisteredUser(targetJid);
            if (!isReg) {
                console.error('Número de teste não registrado no WhatsApp:', TARGET_NUMBER_RAW);
                return process.exit(1);
            }

            for (let i = 0; i < clientes.length; i++) {
                const cliente = clientes[i];
                const mensagem = montarMensagem(cliente, template);

                console.log(`\n[${i + 1}/${clientes.length}] Enviando para ${TARGET_NUMBER_RAW}: ${cliente.nome} | ${cliente.numero || 'sem número'} | R$ ${cliente.valor}`);
                await client.sendMessage(targetJid, mensagem);
                await sleep(1200);
            }

            console.log('\nEnvio concluído para todos os clientes no número de teste.');
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
