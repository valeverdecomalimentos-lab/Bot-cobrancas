const message = require('./message');
const config = require('../config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomWait = () => {
    const time = Math.floor(Math.random() * (config.tempoMax - config.tempoMin + 1)) + config.tempoMin;
    return time;
};

module.exports = {
    enviarMensagens: async (clientes, client) => {
        const resultados = [];
        let index = 1;
        const total = clientes.length;

        for (const cliente of clientes) {
            console.log(`\nCliente ${index}/${total}`);
            console.log(`Processando: ${cliente.nome}...`);

            const statusOriginal = String(cliente.status || '').toLowerCase();
            const ehDevedor = /dev|inadimplente|pendente|em aberto|aberto|vencido|não pago|nao pago/.test(statusOriginal);

            if (config.enviarSomenteDevedores && !ehDevedor) {
                console.log('⚠ Ignorado - Cliente não marcado como devedor.');
                resultados.push({ ...cliente, statusEnvio: 'Ignorado - Não devedor' });
                index++;
                continue;
            }

            if (!cliente.telefoneValido) {
                const motivo = config.ignorarSemTelefone ? 'Ignorado - Sem telefone válido' : 'Sem telefone válido';
                console.log(`❌ ${motivo}.`);
                resultados.push({ ...cliente, statusEnvio: motivo });
                index++;
                continue;
            }

            const texto = message.montar(cliente);

            try {
                const isRegistered = await client.isRegisteredUser(cliente.telefoneValido);
                
                if (isRegistered) {
                    await client.sendMessage(cliente.telefoneValido, texto);
                    console.log(`✔ Enviado com sucesso para ${cliente.telefoneOriginal || cliente.telefoneValido}`);
                    resultados.push({ ...cliente, statusEnvio: 'Enviado' });

                    if (index < total) {
                        const waitTime = randomWait();
                        console.log(`Aguarde ${(waitTime / 1000).toFixed(1)} segundos...`);
                        await sleep(waitTime);
                    }
                } else {
                    console.log('❌ Erro - Número inexistente no WhatsApp.');
                    resultados.push({ ...cliente, statusEnvio: 'Erro - Não tem WhatsApp' });
                }
            } catch (error) {
                console.log(`❌ Erro no envio: ${error.message}`);
                resultados.push({ ...cliente, statusEnvio: `Erro de envio: ${error.message}` });
            }

            index++;
        }

        return resultados;
    }
};