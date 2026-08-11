import { estado, formatarMoeda, formatarData, calcularEnviosSemana } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, escaparHtml, mostrarToast } from '../nucleo/ui.js';
import { renderizarMarkdown, textoDaResposta, metadadosDaResposta } from '../nucleo/markdown.js';
import { Icone } from '../nucleo/icones.js';

function valorDevido(cliente) {
  return Number(cliente.saldo_devedor ?? cliente.valorDevido ?? cliente.valor ?? 0);
}

function limitarPercentual(valor) {
  return Math.max(0, Math.min(100, Number.isFinite(valor) ? valor : 0));
}

function graficoSemana(dados) {
  const maximo = Math.max(...dados.map((item) => item.enviados + item.erros)) || 1;
  const larguraBarra = 30;
  const espacamento = 28;
  const altura = 128;
  const barras = dados.map((item, indice) => {
    const x = indice * (larguraBarra + espacamento) + 8;
    const enviados = Math.max(2, (item.enviados / maximo) * altura);
    const erros = item.erros ? Math.max(2, (item.erros / maximo) * altura) : 0;
    return `<g class="grupo-barra"><rect class="barra-enviados" x="${x}" y="${altura - enviados}" width="${larguraBarra}" height="${enviados}" rx="7"/><rect class="barra-erros" x="${x}" y="${altura - enviados - erros - (erros ? 4 : 0)}" width="${larguraBarra}" height="${erros}" rx="7"/><text x="${x + larguraBarra / 2}" y="${altura + 22}" text-anchor="middle">${item.dia}</text><title>${item.dia}: ${item.enviados} enviados e ${item.erros} erros</title></g>`;
  }).join('');
  return `<svg class="grafico-envios" viewBox="0 0 ${dados.length * (larguraBarra + espacamento) + 10} ${altura + 32}" role="img" aria-label="Envios e erros registrados por dia da semana">${barras}</svg>`;
}

function saudacao() {
  const hora = new Date().getHours();
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

function resumoAcaoPreparada(acao = {}) {
  const quantidade = Number(acao.payload?.recipientCount || acao.payload?.recipientIds?.length || 0);
  if (acao.kind === 'campaign') return { titulo: 'Cobrança preparada', detalhe: `${quantidade} ${quantidade === 1 ? 'destinatário elegível' : 'destinatários elegíveis'}`, botao: 'Revisar campanha' };
  if (acao.kind === 'notification') return { titulo: 'Notificação preparada', detalhe: `${quantidade} contato${quantidade === 1 ? '' : 's'} selecionado${quantidade === 1 ? '' : 's'}`, botao: 'Revisar mensagem' };
  if (acao.kind === 'reminder') return { titulo: 'Lembrete em rascunho', detalhe: 'O agendamento exige revisão humana', botao: 'Levar ao assistente' };
  if (acao.kind === 'report') return { titulo: 'Relatório solicitado', detalhe: 'Será gerado com a base atual', botao: 'Gerar relatório' };
  return { titulo: 'Ação sugerida', detalhe: 'Nenhuma operação foi executada', botao: 'Revisar' };
}

function mensagemIA(item, indice) {
  const gestor = item.papel === 'gestor';
  const metadados = item.metadados || {};
  const continuacoes = Number(metadados.continuacoes || 0);
  const acoes = Array.isArray(metadados.acoes) ? metadados.acoes : [];
  return `
    <article class="mensagem-gemini ${gestor ? 'gestor' : 'gemini'}">
      <header><span class="avatar-mensagem" aria-hidden="true">${gestor ? 'VV' : Icone.sparkles}</span><div><strong>${gestor ? 'Você' : 'Copiloto Vale Verde'}</strong>${continuacoes ? `<small>resposta completada em ${continuacoes + 1} partes</small>` : ''}</div>${!gestor ? `<button class="btn-icone copiar-resposta" type="button" data-copiar="${indice}" aria-label="Copiar resposta">Copiar</button>` : ''}</header>
      <div class="conteudo-markdown">${gestor ? `<p>${escaparHtml(item.texto)}</p>` : renderizarMarkdown(item.texto)}</div>
      ${!gestor && acoes.length ? `<div class="acoes-preparadas-ia" aria-label="Rascunhos operacionais">${acoes.map((acao, acaoIndice) => {
        const resumo = resumoAcaoPreparada(acao);
        return `<div class="acao-preparada-ia"><span>${Icone.check}</span><div><strong>${resumo.titulo}</strong><small>${resumo.detalhe}. Nada foi enviado.</small></div><button class="btn btn--secundario" type="button" data-acao-preparada="${indice}:${acaoIndice}">${resumo.botao}</button></div>`;
      }).join('')}</div>` : ''}
    </article>`;
}

export function montarDashboard(alvo) {
  const totalClientes = estado.clientes.length;
  const devedores = estado.clientes.filter((cliente) => cliente.status === 'devedor' || valorDevido(cliente) > 0);
  const valorAberto = devedores.reduce((soma, cliente) => soma + valorDevido(cliente), 0);
  const clientesComTelefone = estado.clientes.filter((cliente) => String(cliente.telefone || '').replace(/\D/g, '')).length;
  const ultimaCampanha = [...estado.historico].sort((a, b) => new Date(b.data) - new Date(a.data))[0];
  const dadosSemana = calcularEnviosSemana(estado.historico);
  const totalProcessados = estado.historico.reduce((soma, item) => soma + Number(item.total || 0), 0);
  const totalEnviados = estado.historico.reduce((soma, item) => soma + Number(item.enviados || 0), 0);
  const taxaEntrega = totalProcessados ? limitarPercentual((totalEnviados / totalProcessados) * 100) : 0;
  const coberturaTelefone = totalClientes ? limitarPercentual((clientesComTelefone / totalClientes) * 100) : 0;
  const taxaDevedores = totalClientes ? limitarPercentual((devedores.length / totalClientes) * 100) : 0;

  const tela = paraElemento(`
    <div class="dashboard-home">
      <section class="hero-dashboard">
        <div><span class="eyebrow">CENTRAL OPERACIONAL</span><h1>${saudacao()}. Sua operação em um só lugar.</h1><p>Dados locais, campanhas e inteligência para decidir com segurança.</p></div>
        <div class="hero-dashboard__status"><span class="status-pulso ${estado.conexaoWhatsapp.status === 'conectado' ? 'on' : ''}"></span><div><strong>${estado.conexaoWhatsapp.status === 'conectado' ? 'WhatsApp disponível' : 'WhatsApp desconectado'}</strong><small>${estado.conexaoWhatsapp.status === 'conectado' ? 'Pronto para testes e envios' : 'Conecte antes de iniciar campanhas'}</small></div></div>
      </section>

      <section class="grade-resumo" aria-label="Indicadores principais">
        <article class="cartao cartao-metrica cartao-metrica--clientes"><div class="metrica-topo"><span class="metrica-icone">${Icone.clientes}</span><span class="metrica-tag">Base</span></div><div class="rotulo">Clientes cadastrados</div><div class="valor">${totalClientes.toLocaleString('pt-BR')}</div><div class="rodape"><span>${clientesComTelefone} alcançáveis</span><span>${Math.round(coberturaTelefone)}% cobertura</span></div></article>
        <article class="cartao cartao-metrica cartao-metrica--alerta"><div class="metrica-topo"><span class="metrica-icone">${Icone.alerta}</span><span class="metrica-tag">Atenção</span></div><div class="rotulo">Com saldo devedor</div><div class="valor">${devedores.length.toLocaleString('pt-BR')}</div><div class="rodape"><span>${Math.round(taxaDevedores)}% da base</span><span>mínimo R$ 50 no envio</span></div></article>
        <article class="cartao cartao-metrica cartao-metrica--financeiro"><div class="metrica-topo"><span class="metrica-icone">${Icone.cifrao}</span><span class="metrica-tag">Recebíveis</span></div><div class="rotulo">Valor total em aberto</div><div class="valor valor--moeda">${formatarMoeda(valorAberto)}</div><div class="rodape"><span>saldo consolidado</span><span>${devedores.length ? formatarMoeda(valorAberto / devedores.length) : formatarMoeda(0)} médio</span></div></article>
        <article class="cartao cartao-metrica cartao-metrica--campanha"><div class="metrica-topo"><span class="metrica-icone">${Icone.historico}</span><span class="metrica-tag">Performance</span></div><div class="rotulo">Taxa de entrega</div><div class="valor">${Math.round(taxaEntrega)}%</div><div class="rodape"><span>${totalEnviados} enviados</span><span>${ultimaCampanha ? formatarData(ultimaCampanha.data).split(' ')[0] : 'sem campanha'}</span></div></article>
      </section>

      <section class="grade-acoes" aria-label="Ações rápidas">
        <button class="cartao acao-grande cobranca" id="acao-cobranca"><span class="icone">${Icone.alerta}</span><span><small>FLUXO SEGURO</small><h3>Nova cobrança</h3><p>Preparar mensagem, revisar público e enviar um teste.</p></span><span class="acao-seta">${Icone.seta}</span></button>
        <button class="cartao acao-grande campanha" id="acao-campanha"><span class="icone">${Icone.campanha}</span><span><small>RELACIONAMENTO</small><h3>Campanha promocional</h3><p>Engajar a base com uma comunicação personalizada.</p></span><span class="acao-seta">${Icone.seta}</span></button>
      </section>

      <section class="grade-operacao">
        <article class="cartao painel-grafico">
          <div class="cabecalho"><div><span class="eyebrow">ÚLTIMOS REGISTROS</span><h2>Ritmo de envios</h2></div><div class="legenda-grafico"><span><i class="legenda-enviados"></i>Enviados</span><span><i class="legenda-erros"></i>Erros</span></div></div>
          ${estado.historico.length ? graficoSemana(dadosSemana) : `<div class="estado-vazio estado-vazio--compacto">${Icone.historico}<p>As campanhas aparecerão aqui assim que o primeiro relatório for gerado.</p></div>`}
        </article>
        <aside class="cartao radar-operacional">
          <div><span class="eyebrow">RADAR DA BASE</span><h2>Prontidão operacional</h2></div>
          <div class="radar-item"><div><span>Cobertura de telefone</span><strong>${Math.round(coberturaTelefone)}%</strong></div><div class="barra-progresso"><i style="width:${coberturaTelefone}%"></i></div></div>
          <div class="radar-item"><div><span>Entrega das campanhas</span><strong>${Math.round(taxaEntrega)}%</strong></div><div class="barra-progresso"><i style="width:${taxaEntrega}%"></i></div></div>
          <div class="radar-item radar-item--alerta"><div><span>Clientes devedores</span><strong>${Math.round(taxaDevedores)}%</strong></div><div class="barra-progresso"><i style="width:${taxaDevedores}%"></i></div></div>
          <button class="btn btn--fantasma radar-link" id="abrir-clientes">Revisar qualidade da base ${Icone.seta}</button>
        </aside>
      </section>

      <section class="cartao painel-gemini" id="painel-gemini" aria-label="Copiloto de inteligência operacional"></section>
    </div>`);
  alvo.appendChild(tela);

  tela.querySelector('#acao-cobranca').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'cobranca'; navegar('nova-campanha'); });
  tela.querySelector('#acao-campanha').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'promocao'; navegar('nova-campanha'); });
  tela.querySelector('#abrir-clientes').addEventListener('click', () => navegar('clientes'));

  const painelGemini = tela.querySelector('#painel-gemini');
  let carregandoRelatorio = false;
  let carregandoDiagnostico = false;
  let respondendo = false;
  let preparandoCampanha = false;
  let rascunhoPergunta = '';

  function renderizarGemini() {
    const configurado = estado.gemini.disponivel;
    const temDados = estado.clientes.length > 0 || estado.produtos.length > 0;
    const relatorio = estado.gemini.relatorio;
    const diagnostico = estado.gemini.diagnostico;
    const conversa = Array.isArray(estado.gemini.conversa) ? estado.gemini.conversa : [];
    const ocupado = carregandoRelatorio || carregandoDiagnostico || respondendo || preparandoCampanha;
    const provedorNome = estado.gemini.provedorNome
      || (estado.gemini.provedor === 'openai' ? 'OpenAI' : 'Google Gemini');

    painelGemini.innerHTML = `
      <div class="cabecalho-gemini">
        <div class="identidade-ia"><span class="orbe-ia">${Icone.sparkles}</span><div><span class="eyebrow">INTELIGÊNCIA CONTEXTUAL</span><h2>Copiloto Vale Verde</h2><p>Analisa clientes, estoque, importações e campanhas sem executar envios por conta própria.</p></div></div>
        <div class="status-ia">${configurado ? `<span class="badge badge--sucesso">Online</span><small>${escaparHtml(provedorNome)}${estado.gemini.modelo ? ` · ${escaparHtml(estado.gemini.modelo)}` : ''}</small>` : '<span class="badge badge--neutro">Não configurado</span>'}</div>
      </div>
      ${!configurado ? `<div class="estado-ia estado-ia--indisponivel"><span>${Icone.sparkles}</span><div><h3>Conecte a inteligência do painel</h3><p>Escolha Gemini ou OpenAI e cadastre a chave com segurança nas Configurações. Não é necessário editar arquivos de ambiente.</p><button class="btn btn--primario" id="btn-configurar-ia" type="button">Configurar inteligência</button></div></div>` : !temDados ? `<div class="estado-ia"><span>${Icone.upload}</span><div><h3>A IA está pronta, mas precisa de contexto</h3><p>Importe uma planilha de clientes ou produtos para começar.</p></div></div>` : `
        <div class="contexto-ia" aria-label="Fontes de contexto ativas"><span>${estado.clientes.length} clientes</span><span>${estado.produtos.length} produtos</span><span>${estado.importacoes.length} importações</span><span>${estado.historico.length} relatórios</span></div>
        <div class="acoes-ia">
          <button class="acao-ia" id="btn-gerar-relatorio" ${ocupado ? 'disabled' : ''}><span>${Icone.painel}</span><div><strong>${carregandoRelatorio ? 'Analisando a operação…' : 'Relatório executivo'}</strong><small>Resumo completo e prioridades</small></div></button>
          <button class="acao-ia" id="btn-diagnosticar" ${ocupado ? 'disabled' : ''}><span>${Icone.alerta}</span><div><strong>${carregandoDiagnostico ? 'Investigando sinais…' : 'Diagnóstico operacional'}</strong><small>Riscos, causas e próximas ações</small></div></button>
          <button class="acao-ia" data-preparar-campanha="cobranca" ${ocupado ? 'disabled' : ''}><span>${Icone.cifrao}</span><div><strong>${preparandoCampanha ? 'Preparando rascunho…' : 'Cobrança inteligente'}</strong><small>Cria mensagem para sua revisão</small></div></button>
        </div>
        ${relatorio || diagnostico ? `<div class="insights-ia">
          ${relatorio ? `<article><header><span>RELATÓRIO EXECUTIVO</span></header><div class="conteudo-markdown">${renderizarMarkdown(relatorio)}</div></article>` : ''}
          ${diagnostico ? `<article class="insight-diagnostico"><header><span>DIAGNÓSTICO ATUAL</span></header><div class="conteudo-markdown">${renderizarMarkdown(diagnostico)}</div></article>` : ''}
        </div>` : ''}
        <div class="chat-gemini">
          <div class="chat-gemini__topo"><div><h3>Converse com seus dados</h3><p>Faça perguntas, compare cenários ou peça um plano de ação.</p></div>${conversa.length ? '<button class="btn btn--fantasma" id="btn-limpar-conversa" type="button">Limpar conversa</button>' : ''}</div>
          ${!conversa.length ? `<div class="sugestoes-ia"><button data-prompt="Quais pontos exigem minha atenção hoje?">O que exige atenção hoje?</button><button data-prompt="Mostre os principais riscos de inadimplência e como priorizar as cobranças.">Priorizar cobranças</button><button data-prompt="Analise o estoque e aponte riscos e oportunidades comerciais.">Analisar estoque</button></div>` : ''}
          <div id="conversa-gemini" class="conversa-gemini" role="log" aria-live="polite">${conversa.map(mensagemIA).join('')}${respondendo ? `<article class="mensagem-gemini gemini mensagem-carregando"><header><span class="avatar-mensagem">${Icone.sparkles}</span><strong>Copiloto Vale Verde</strong></header><div class="digitando"><i></i><i></i><i></i><span>Consultando a base completa…</span></div></article>` : ''}</div>
          <div class="composer-ia"><textarea id="pergunta-gemini" rows="2" maxlength="4000" placeholder="Ex.: quais clientes devo priorizar e por quê?" ${respondendo ? 'disabled' : ''}>${escaparHtml(rascunhoPergunta)}</textarea><button class="btn btn--primario" id="btn-perguntar" ${respondendo ? 'disabled' : ''}>${respondendo ? 'Analisando…' : `Perguntar ${Icone.seta}`}</button></div>
          <p class="nota-ia">O contexto necessário é enviado à ${escaparHtml(provedorNome)}; contatos, documentos e segredos de planilhas são omitidos. Revise respostas e ações antes de qualquer campanha.</p>
        </div>`}`;

    if (!configurado) {
      painelGemini.querySelector('#btn-configurar-ia')?.addEventListener('click', () => navegar('configuracoes'));
      return;
    }
    if (!temDados) return;
    painelGemini.querySelector('#btn-gerar-relatorio')?.addEventListener('click', gerarRelatorio);
    painelGemini.querySelector('#btn-diagnosticar')?.addEventListener('click', diagnosticar);
    painelGemini.querySelectorAll('[data-preparar-campanha]').forEach((botao) => botao.addEventListener('click', () => prepararCampanha(botao.dataset.prepararCampanha)));
    painelGemini.querySelectorAll('[data-prompt]').forEach((botao) => botao.addEventListener('click', () => perguntar(null, botao.dataset.prompt)));
    painelGemini.querySelector('#btn-limpar-conversa')?.addEventListener('click', limparConversa);

    const campoPergunta = painelGemini.querySelector('#pergunta-gemini');
    const botaoPerguntar = painelGemini.querySelector('#btn-perguntar');
    campoPergunta?.addEventListener('input', () => { rascunhoPergunta = campoPergunta.value; });
    campoPergunta?.addEventListener('keydown', (evento) => {
      if (evento.key === 'Enter' && !evento.shiftKey) {
        evento.preventDefault();
        perguntar(campoPergunta);
      }
    });
    botaoPerguntar?.addEventListener('click', () => perguntar(campoPergunta));
    painelGemini.querySelectorAll('[data-copiar]').forEach((botao) => botao.addEventListener('click', async () => {
      const item = conversa[Number(botao.dataset.copiar)];
      if (!item) return;
      try {
        await navigator.clipboard.writeText(item.texto);
        mostrarToast('Resposta copiada.', 'sucesso');
      } catch {
        mostrarToast('Não foi possível copiar a resposta.', 'erro');
      }
    }));
    painelGemini.querySelectorAll('[data-acao-preparada]').forEach((botao) => botao.addEventListener('click', () => abrirAcaoPreparada(botao)));

    requestAnimationFrame(() => {
      const lista = painelGemini.querySelector('#conversa-gemini');
      if (lista && conversa.length) lista.scrollTop = lista.scrollHeight;
    });
  }

  async function gerarRelatorio() {
    carregandoRelatorio = true;
    renderizarGemini();
    try {
      const resposta = await api.generateExecutiveReport();
      estado.gemini.relatorio = textoDaResposta(resposta);
      mostrarToast('Relatório executivo atualizado.', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível gerar o relatório.', 'erro');
    } finally {
      carregandoRelatorio = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function diagnosticar() {
    carregandoDiagnostico = true;
    renderizarGemini();
    try {
      const resposta = await api.diagnoseGemini();
      estado.gemini.diagnostico = textoDaResposta(resposta);
      mostrarToast('Diagnóstico concluído.', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível diagnosticar a operação.', 'erro');
    } finally {
      carregandoDiagnostico = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function perguntar(campo, promptDireto = '') {
    const texto = String(promptDireto || campo?.value || rascunhoPergunta).trim();
    if (!texto || respondendo) return;
    respondendo = true;
    rascunhoPergunta = '';
    estado.gemini.conversa.push({ id: `local-${Date.now()}`, papel: 'gestor', texto, criadoEm: new Date().toISOString() });
    renderizarGemini();
    try {
      const resposta = await api.askGemini({
        pergunta: texto,
        relatorioAnterior: estado.gemini.relatorio,
        historico: estado.gemini.conversa.slice(-12),
      });
      const respostaTexto = textoDaResposta(resposta);
      if (!respostaTexto) throw new Error('A IA não retornou conteúdo.');
      estado.gemini.conversa.push({
        id: `local-${Date.now()}-ia`,
        papel: 'gemini',
        texto: respostaTexto,
        criadoEm: new Date().toISOString(),
        metadados: metadadosDaResposta(resposta),
      });
    } catch (error) {
      estado.gemini.conversa.pop();
      rascunhoPergunta = texto;
      mostrarToast(error.message || 'Não foi possível consultar a IA.', 'erro');
    } finally {
      respondendo = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function prepararCampanha(tipo) {
    if (preparandoCampanha) return;
    preparandoCampanha = true;
    renderizarGemini();
    try {
      const resposta = await api.suggestCampaignMessage({ tipo, mensagemAtual: '' });
      estado.rascunhoCampanhaIA = { tipo, mensagem: textoDaResposta(resposta), criadoEm: new Date().toISOString() };
      estado.novaCampanhaTipoInicial = tipo;
      mostrarToast('Rascunho preparado. Revise antes de enviar.', 'sucesso');
      navegar('nova-campanha');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível preparar a campanha.', 'erro');
    } finally {
      preparandoCampanha = false;
      if (tela.isConnected) renderizarGemini();
    }
  }

  async function abrirAcaoPreparada(botao) {
    const [mensagemIndice, acaoIndice] = String(botao.dataset.acaoPreparada || '').split(':').map(Number);
    const acao = estado.gemini.conversa[mensagemIndice]?.metadados?.acoes?.[acaoIndice];
    if (!acao || botao.disabled) return;
    botao.disabled = true;
    const rotuloOriginal = botao.textContent;
    botao.textContent = 'Preparando…';
    try {
      if (acao.kind === 'report') {
        await gerarRelatorio();
        painelGemini.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      const tipo = acao.kind === 'campaign' ? 'cobranca' : 'promocao';
      const mensagemExistente = String(acao.payload?.messageDraft || '').trim();
      const resposta = mensagemExistente
        ? mensagemExistente
        : await api.suggestCampaignMessage({ tipo, mensagemAtual: String(acao.payload?.messageDraft || '') });
      estado.rascunhoCampanhaIA = {
        tipo,
        mensagem: textoDaResposta(resposta),
        recipientIds: Array.isArray(acao.payload?.recipientIds) ? acao.payload.recipientIds.map(String) : [],
        criadoEm: new Date().toISOString(),
      };
      estado.novaCampanhaTipoInicial = tipo;
      mostrarToast(acao.kind === 'reminder'
        ? 'Rascunho criado. Defina o momento do envio após a revisão.'
        : 'Rascunho operacional pronto para revisão.', 'sucesso');
      navegar('nova-campanha');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível preparar esta ação.', 'erro');
      if (botao.isConnected) {
        botao.disabled = false;
        botao.textContent = rotuloOriginal;
      }
    }
  }

  async function limparConversa() {
    try {
      if (api.clearGeminiHistory) await api.clearGeminiHistory();
      estado.gemini.conversa = [];
      mostrarToast('Conversa limpa.', 'sucesso');
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível limpar a conversa.', 'erro');
    } finally {
      if (tela.isConnected) renderizarGemini();
    }
  }

  renderizarGemini();
}
