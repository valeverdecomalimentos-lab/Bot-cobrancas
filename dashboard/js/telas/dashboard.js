import { estado, formatarMoeda, formatarData, calcularEnviosSemana } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function valorDevido(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

function graficoSemana(dados) {
  const maximo = Math.max(...dados.map((item) => item.enviados + item.erros)) || 1;
  const larguraBarra = 34;
  const espacamento = 26;
  const altura = 130;
  const barras = dados.map((item, indice) => {
    const x = indice * (larguraBarra + espacamento);
    const enviados = (item.enviados / maximo) * altura;
    const erros = (item.erros / maximo) * altura;
    return `<rect x="${x}" y="${altura - enviados}" width="${larguraBarra}" height="${enviados}" rx="4" fill="#3E6650"/><rect x="${x}" y="${altura - enviados - erros - 3}" width="${larguraBarra}" height="${erros}" rx="4" fill="#B34A3D"/><text x="${x + larguraBarra / 2}" y="${altura + 18}" font-size="11" fill="#5B6459" text-anchor="middle">${item.dia}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${dados.length * (larguraBarra + espacamento)} ${altura + 30}" width="100%" height="170" aria-label="Grafico de envios">${barras}</svg>`;
}

export function montarDashboard(alvo) {
  const totalClientes = estado.clientes.length;
  const devedores = estado.clientes.filter((cliente) => cliente.status === 'devedor' || valorDevido(cliente) > 0);
  const valorAberto = devedores.reduce((soma, cliente) => soma + valorDevido(cliente), 0);
  const ultimaCampanha = [...estado.historico].sort((a, b) => new Date(b.data) - new Date(a.data))[0];
  const dadosSemana = calcularEnviosSemana(estado.historico);
  const tela = paraElemento(`
    <div>
      <div class="topo-pagina"><div><h1>Visao geral</h1><p class="legenda">Dados consolidados da base local e dos relatorios salvos.</p></div></div>
      <div class="grade-resumo">
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.clientes} Clientes cadastrados</div><div class="valor">${totalClientes}</div><div class="rodape">base ativa</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.alerta} Com saldo devedor</div><div class="valor">${devedores.length}</div><div class="rodape">${totalClientes ? Math.round((devedores.length / totalClientes) * 100) : 0}% da base</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.cifrao} Valor total em aberto</div><div class="valor">${formatarMoeda(valorAberto)}</div><div class="rodape">a receber</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.relogio} Ultima campanha</div><div class="valor" style="font-size:18px">${ultimaCampanha ? formatarData(ultimaCampanha.data).split(' ')[0] : '--'}</div><div class="rodape">${ultimaCampanha ? `${ultimaCampanha.total ?? '--'} processados` : 'sem relatorios'}</div></div>
      </div>
      <div class="grade-acoes">
        <button class="cartao acao-grande cobranca" id="acao-cobranca"><span class="icone">${Icone.alerta}</span><span><h3>Nova cobranca</h3><p>Somente devedores a partir de R$ 50,00.</p></span></button>
        <button class="cartao acao-grande campanha" id="acao-campanha"><span class="icone">${Icone.campanha}</span><span><h3>Nova campanha promocional</h3><p>Enviar para a base com telefone valido.</p></span></button>
      </div>
      <div class="cartao painel-grafico">
        <div class="cabecalho"><h3>Envios registrados</h3><div class="legenda-grafico"><span><i style="background:#3E6650"></i>Enviados</span><span><i style="background:#B34A3D"></i>Erros</span></div></div>
        ${estado.historico.length ? graficoSemana(dadosSemana) : `<div class="estado-vazio">${Icone.historico}<p>Ainda nao ha relatorios salvos para montar o grafico.</p></div>`}
      </div>
      <div class="cartao painel-gemini" id="painel-gemini"></div>
    </div>`);
  alvo.appendChild(tela);
  tela.querySelector('#acao-cobranca').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'cobranca'; navegar('nova-campanha'); });
  tela.querySelector('#acao-campanha').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'promocao'; navegar('nova-campanha'); });

  const painelGemini = tela.querySelector('#painel-gemini');
  let carregandoRelatorio = false;
  let carregandoDiagnostico = false;
  let respondendo = false;

  function renderizarGemini() {
    const configurado = estado.gemini.disponivel;
    const temDados = estado.clientes.length > 0 || estado.produtos.length > 0;
    const relatorio = estado.gemini.relatorio;
    const diagnostico = estado.gemini.diagnostico;
    painelGemini.innerHTML = `
      <div class="cabecalho-gemini"><div><h3>Gemini AI</h3><p>Analise financeira, estoque, campanhas e qualidade da base.</p></div>${configurado ? `<span class="badge badge--sucesso">${escaparHtml(estado.gemini.modelo || 'Disponivel')}</span>` : '<span class="badge badge--neutro">Chave nao configurada</span>'}</div>
      ${!configurado ? '<div class="estado-vazio"><p>Configure uma chave Gemini no arquivo .env para habilitar as analises.</p></div>' : !temDados ? '<div class="estado-vazio"><p>Importe clientes ou produtos para gerar analises.</p></div>' : `
        <div class="resposta-gemini" id="resposta-gemini">${relatorio ? escaparHtml(relatorio) : 'Gere o relatorio executivo para analisar a operacao da loja.'}</div>
        ${diagnostico ? `<div class="resposta-gemini diagnostico-gemini"><strong>Diagnostico operacional</strong><span>${escaparHtml(diagnostico)}</span></div>` : ''}
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn btn--secundario" id="btn-gerar-relatorio" ${carregandoRelatorio ? 'disabled' : ''}>${carregandoRelatorio ? 'Gerando...' : 'Gerar relatorio executivo'}</button><button class="btn btn--secundario" id="btn-diagnosticar" ${carregandoDiagnostico ? 'disabled' : ''}>${carregandoDiagnostico ? 'Diagnosticando...' : 'Diagnosticar operacao'}</button></div>
        ${relatorio ? `<div class="chat-gemini"><div id="conversa-gemini">${estado.gemini.conversa.map((item) => `<div class="mensagem-gemini ${item.papel}"><strong>${item.papel === 'gestor' ? 'Voce' : 'Gemini'}</strong><span>${escaparHtml(item.texto)}</span></div>`).join('')}</div><div style="display:flex;gap:8px"><input type="text" id="pergunta-gemini" placeholder="Pergunte sobre a base atual" ${respondendo ? 'disabled' : ''}><button class="btn btn--primario" id="btn-perguntar" ${respondendo ? 'disabled' : ''}>${respondendo ? 'Consultando...' : 'Perguntar'}</button></div></div>` : ''}`}`;
    if (configurado && temDados) {
      painelGemini.querySelector('#btn-gerar-relatorio').addEventListener('click', gerarRelatorio);
      painelGemini.querySelector('#btn-diagnosticar').addEventListener('click', diagnosticar);
      const botaoPerguntar = painelGemini.querySelector('#btn-perguntar');
      if (botaoPerguntar) {
        const pergunta = painelGemini.querySelector('#pergunta-gemini');
        botaoPerguntar.addEventListener('click', () => perguntar(pergunta));
        pergunta.addEventListener('keydown', (event) => { if (event.key === 'Enter') perguntar(pergunta); });
      }
    }
  }

  async function gerarRelatorio() {
    carregandoRelatorio = true;
    renderizarGemini();
    try {
      estado.gemini.relatorio = await api.generateExecutiveReport();
      estado.gemini.conversa = [];
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel gerar o relatorio.', 'erro');
    } finally {
      carregandoRelatorio = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function diagnosticar() {
    carregandoDiagnostico = true;
    renderizarGemini();
    try {
      estado.gemini.diagnostico = await api.diagnoseGemini();
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel diagnosticar a operacao.', 'erro');
    } finally {
      carregandoDiagnostico = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function perguntar(campo) {
    const texto = campo.value.trim();
    if (!texto || respondendo) return;
    respondendo = true;
    estado.gemini.conversa.push({ papel: 'gestor', texto });
    renderizarGemini();
    try {
      const resposta = await api.askGemini({ pergunta: texto, relatorioAnterior: estado.gemini.relatorio });
      estado.gemini.conversa.push({ papel: 'gemini', texto: resposta });
    } catch (error) {
      estado.gemini.conversa.pop();
      mostrarToast(error.message || 'Nao foi possivel consultar a Gemini.', 'erro');
    } finally {
      respondendo = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  renderizarGemini();
}
