const pix = Object.freeze({
    nomeFavorecido: 'Israel Felipe de Oliveira Donadio',
    chave: '22998628769',
    tipo: 'telefone',
});

module.exports = {
    // `PIX` continua disponivel para scripts antigos. Codigo novo deve usar `pix`.
    PIX: pix.chave,
    PIX_NOME_FAVORECIDO: pix.nomeFavorecido,
    PIX_TIPO: pix.tipo,
    pix,
    tempoMin: 5000, // 5 segundos
    tempoMax: 11000, // 11 segundos
    campanhas: {
        '1': {
            nome: 'Cobrança',
            somenteDevedores: true,
            template: 'cobranca.txt'
        },
        '2': {
            nome: 'Promoção',
            somenteDevedores: false,
            template: 'promocao.txt'
        }
    },
    ignorarSemTelefone: true
};
