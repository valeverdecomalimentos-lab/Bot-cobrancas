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
        
        const clientesParaEnviar = clientes.filter(c => {
            if(config.ignorarSemTelefone && !c.telefoneValido) return false;
            return true;
        });

        const total = clientesParaEnviar.length;

        for (const cliente of clientesParaEnviar) {
            console.log(`\nCliente ${index}/${total}`);
            console.log(`Processando: ${cliente.nome}...`);

            if(!cliente.telefoneValido) {
                console.log(`❌ Ignorado - Sem telefone válido.`);
                resultados.push({ ...cliente, statusEnvio: 'Ignorado' });
                index++;
                continue;
            }

            const texto = message.montar(cliente);

            try {
                const isRegistered = await client.isRegisteredUser(cliente.telefoneValido);
                
                if(isRegistered) {
                    await client.sendMessage(cliente.telefoneValido, texto);
                    console.log(`✔ Enviado com sucesso para ${cliente.telefoneOriginal}`);
                    resultados.push({ ...cliente, statusEnvio: 'Enviado' });
                    
                    if(index < total) {
                        const waitTime = randomWait();
                        console.log(`Aguarde ${(waitTime/1000).toFixed(1)} segundos...`);
                        await sleep(waitTime);
                    }
                } else {
                    console.log(`❌ Erro - Número inexistente no WhatsApp.`);
                    resultados.push({ ...cliente, statusEnvio: 'Erro - Não tem WhatsApp' });
                }
            } catch (error) {
                console.log(`❌ Erro no envio: ${error.message}`);
                resultados.push({ ...cliente, statusEnvio: 'Erro de conexão' });
            }
            
            index++;
        }
        
        return resultados;
    }
};