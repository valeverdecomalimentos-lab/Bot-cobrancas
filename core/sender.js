const message = require('./message');
const config = require('../config');
const {
    DEBTOR_THRESHOLD,
    filterDebtorsThreshold,
    filterCustomersWithPhone,
    normalizeCustomer,
    normalizePhoneDigits,
    toWhatsappId,
} = require('./customer-utils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomWait(min = config.tempoMin, max = config.tempoMax) {
    const safeMin = Number(min || 0);
    const safeMax = Math.max(Number(max || safeMin), safeMin);
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function resolveRecipients(clientes, campanha) {
    const normalized = clientes.map((cliente) => normalizeCustomer(cliente, { keepRaw: false })).filter(Boolean);
    if (campanha.somenteDevedores || campanha.tipoEnvio === 'devedores' || campanha.tipo === 'cobranca') {
        return filterDebtorsThreshold(normalized, campanha.limiteMinimoDevedor ?? DEBTOR_THRESHOLD);
    }
    return filterCustomersWithPhone(normalized);
}

function resolveMessage(cliente, campanha) {
    if (campanha.templateText || campanha.mensagem) {
        return message.montarComTexto(cliente, campanha.templateText || campanha.mensagem, campanha.mostrarRodapeContato);
    }
    return message.montar(cliente, campanha.template, campanha.mostrarRodapeContato);
}

function classify(status) {
    if (/^Enviado/i.test(status)) return 'enviado';
    if (/^Ignorado/i.test(status)) return 'ignorado';
    return 'erro';
}

module.exports = {
    filtrarDestinatariosCampanha: resolveRecipients,

    enviarTeste: async ({ telefone, mensagem, clienteExemplo }, client) => {
        if (!client) throw new Error('Cliente WhatsApp indisponivel.');
        if (!clienteExemplo) throw new Error('Nenhum cliente real esta disponivel para renderizar o teste.');
        const telefoneValido = toWhatsappId(telefone);
        if (!telefoneValido) throw new Error('Telefone de teste invalido.');
        const cliente = normalizeCustomer({
            ...clienteExemplo,
            telefone,
            telefoneOriginal: telefone,
        }, { keepRaw: false });

        const texto = message.montarComTexto(cliente, mensagem, false);
        const isRegistered = await client.isRegisteredUser(telefoneValido);
        if (!isRegistered) throw new Error('Numero de teste nao possui WhatsApp.');

        await client.sendMessage(telefoneValido, texto);
        return { statusEnvio: 'Enviado (teste)', telefoneValido };
    },

    enviarMensagens: async (clientes, client, campanha = {}, options = {}) => {
        const campanhaEscolhida = campanha || {};
        const candidatos = resolveRecipients(clientes, campanhaEscolhida);
        const resultados = [];
        const total = candidatos.length;

        for (let i = 0; i < total; i += 1) {
            if (options.shouldCancel?.()) break;
            while (options.shouldPause?.()) await sleep(400);

            const cliente = candidatos[i];
            const indice = i + 1;
            let resultado;

            try {
                if (!cliente.telefoneValido) {
                    resultado = { ...cliente, statusEnvio: 'Ignorado - Sem telefone valido' };
                } else {
                    const texto = resolveMessage(cliente, campanhaEscolhida);
                    const isRegistered = await client.isRegisteredUser(cliente.telefoneValido);

                    if (isRegistered) {
                        await client.sendMessage(cliente.telefoneValido, texto);
                        resultado = { ...cliente, statusEnvio: 'Enviado' };
                    } else {
                        resultado = { ...cliente, statusEnvio: 'Erro - Nao tem WhatsApp' };
                    }
                }
            } catch (error) {
                resultado = { ...cliente, statusEnvio: `Erro de envio: ${error.message}` };
            }

            resultados.push(resultado);
            options.onProgress?.({
                indice,
                total,
                cliente: {
                    id: cliente.id,
                    nome: cliente.nome,
                    telefone: normalizePhoneDigits(cliente.telefone),
                },
                statusEnvio: resultado.statusEnvio,
                classe: classify(resultado.statusEnvio),
            });

            if (i < total - 1 && options.delay !== false) {
                await sleep(randomWait(options.tempoMin, options.tempoMax));
            }
        }

        return resultados;
    },
};
