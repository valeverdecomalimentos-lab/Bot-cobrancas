module.exports = {
    PIX: "22998628769",
    tempoMin: 5000, // 5 segundos
    tempoMax: 11000, // 11 segundos
    campanhas: {
        '1': {
            nome: 'Cobrança',
            somenteDevedores: true,
            template: 'cobranca.txt',
            mostrarRodapeContato: true
        },
        '2': {
            nome: 'Promoção',
            somenteDevedores: false,
            template: 'promocao.txt',
            mostrarRodapeContato: false
        }
    },
    ignorarSemTelefone: true
};