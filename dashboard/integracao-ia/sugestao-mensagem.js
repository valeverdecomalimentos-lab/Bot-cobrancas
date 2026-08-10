// Módulo opcional e desacoplado: gera sugestão de texto de mensagem via
// Gemini. Não é chamado por nada automaticamente — plugue no seu app.js
// (Express) do backend existente conforme o exemplo no fim do arquivo.
//
// Variável de ambiente esperada (.env do backend): GEMINIKEY=sua_chave_aqui

const ENDPOINT_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/**
 * @param {{ tipo: 'cobranca'|'promocao', tomDeVoz?: string }} parametros
 * @returns {Promise<string>} texto sugerido, já com {{nome}} e {{valor}} quando aplicável
 */
async function sugerirMensagem({ tipo, tomDeVoz = 'cordial e objetivo' }) {
  const chave = process.env.GEMINIKEY;
  if (!chave) throw new Error('GEMINIKEY não configurada no .env do backend');

  const instrucao = tipo === 'cobranca'
    ? 'Escreva uma mensagem curta de cobrança amigável para WhatsApp, de uma empresa de alimentos chamada Vale Verde, usando os placeholders {{nome}} e {{valor}}. Tom: ' + tomDeVoz + '. Sem emojis em excesso, no máximo 3 frases.'
    : 'Escreva uma mensagem curta de divulgação promocional para WhatsApp, da empresa de alimentos Vale Verde, usando o placeholder {{nome}}. Tom: ' + tomDeVoz + '. No máximo 3 frases.';

  const resposta = await fetch(`${ENDPOINT_GEMINI}?key=${chave}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: instrucao }] }] }),
  });

  if (!resposta.ok) throw new Error(`Gemini respondeu ${resposta.status}`);
  const dados = await resposta.json();
  const texto = dados?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!texto) throw new Error('Resposta da IA vazia ou em formato inesperado');
  return texto;
}

module.exports = { sugerirMensagem };

/* Exemplo de rota Express a adicionar no backend (app.js do bot):

const { sugerirMensagem } = require('./integracao-ia/sugestao-mensagem');

app.post('/api/ia/sugerir-mensagem', async (req, res) => {
  try {
    const texto = await sugerirMensagem({ tipo: req.body.tipo });
    res.json({ texto });
  } catch (erro) {
    res.status(502).json({ erro: erro.message });
  }
});

No front-end (js/telas/campanha-wizard.js), a Etapa 2 pode então chamar
POST /api/ia/sugerir-mensagem e preencher o textarea com o retorno —
troque SIMULADO para false em js/nucleo/pontos-integracao.js quando isso
estiver ativo.
*/
