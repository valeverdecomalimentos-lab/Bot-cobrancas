import { estado, formatarTelefone } from '../nucleo/estado.js';
import { api } from '../nucleo/pontos-integracao.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function tipoDoResultado(status) {
  if (/^Enviado/i.test(status)) return { nome: 'Enviado', tom: 'sucesso', icone: Icone.check };
  if (/^Ignorado/i.test(status)) return { nome: 'Ignorado', tom: 'neutro', icone: Icone.aviso };
  return { nome: 'Erro', tom: 'erro', icone: Icone.x };
}

export function montarEnvio(alvo) {
  const campanha = estado.campanhaEmAndamento;
  if (!campanha) {
    const vazio = paraElemento(`
      <div class="estado-vazio" role="status">
        ${Icone.campanha}
        <h1>Nenhuma campanha ativa</h1>
        <p>Crie e revise uma campanha antes de iniciar os envios.</p>
        <button class="btn btn--primario" type="button" data-nova-campanha>Criar campanha</button>
      </div>`);
    vazio.querySelector('[data-nova-campanha]').addEventListener('click', () => navegar('nova-campanha'));
    alvo.appendChild(vazio);
    return;
  }

  const totalInformado = Number(campanha.totalPlanejado || campanha.recipientIds?.length || 0);
  const total = Number.isFinite(totalInformado) ? Math.max(0, Math.trunc(totalInformado)) : 0;
  const raio = 62;
  const circunferencia = 2 * Math.PI * raio;
  const progressoSalvo = campanha.progresso && typeof campanha.progresso === 'object' ? campanha.progresso : {};
  let enviados = Number(progressoSalvo.enviados || 0);
  let erros = Number(progressoSalvo.erros || 0);
  let ignorados = Number(progressoSalvo.ignorados || 0);
  let finalizado = false;
  let pausado = false;

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Envio em andamento</h1><p class="legenda">${campanha.tipo === 'cobranca' ? 'Campanha de cobrança' : 'Campanha promocional'} · ${total} destinatários planejados</p></div>
        <div style="display:flex;gap:10px"><button class="btn btn--secundario" id="btn-pausar" type="button" aria-pressed="false">${Icone.pausa} Pausar</button><button class="btn btn--perigo" id="btn-cancelar" type="button">Cancelar</button></div>
      </div>
      <div class="cartao" style="padding:26px;display:flex;gap:34px;align-items:center;flex-wrap:wrap;margin-bottom:20px">
        <div class="anel-progresso" role="progressbar" aria-label="Progresso dos envios" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true"><circle cx="75" cy="75" r="${raio}" stroke="#D6E0D6" stroke-width="12" fill="none"/><circle id="circulo-progresso" cx="75" cy="75" r="${raio}" stroke="#3E6650" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${circunferencia}" stroke-dashoffset="${circunferencia}"/></svg>
          <div class="texto"><strong id="txt-contagem">0/${total}</strong><span id="txt-percentual">0%</span></div>
        </div>
        <div style="flex:1;min-width:200px;display:flex;gap:24px" aria-live="polite" aria-atomic="true"><div><div class="rotulo">${Icone.check} Enviados</div><div class="valor" id="txt-enviados">0</div></div><div><div class="rotulo">${Icone.x} Erros</div><div class="valor" id="txt-erros">0</div></div><div><div class="rotulo">${Icone.aviso} Ignorados</div><div class="valor" id="txt-ignorados">0</div></div></div>
      </div>
      <section class="cartao" aria-labelledby="titulo-log-envio"><div id="titulo-log-envio" style="padding:14px 16px;border-bottom:1px solid var(--vv-linha);font-weight:600;font-size:14px">Log de envio</div><div class="log-envio" id="log-envio" role="log" aria-live="polite" aria-relevant="additions"><p class="estado-vazio" id="log-vazio">Aguardando o primeiro resultado...</p></div></section>
    </div>`);
  alvo.appendChild(tela);
  const log = tela.querySelector('#log-envio');
  const botaoPausar = tela.querySelector('#btn-pausar');
  const botaoCancelar = tela.querySelector('#btn-cancelar');

  function quantidadeProcessada() {
    return enviados + erros + ignorados;
  }

  function atualizarResumo() {
    const processados = quantidadeProcessada();
    const percentual = total ? Math.min(100, Math.round((processados / total) * 100)) : 0;
    tela.querySelector('#txt-contagem').textContent = `${processados}/${total}`;
    tela.querySelector('#txt-percentual').textContent = `${percentual}%`;
    tela.querySelector('#txt-enviados').textContent = enviados;
    tela.querySelector('#txt-erros').textContent = erros;
    tela.querySelector('#txt-ignorados').textContent = ignorados;
    tela.querySelector('.anel-progresso').setAttribute('aria-valuenow', String(percentual));
    tela.querySelector('#circulo-progresso').setAttribute('stroke-dashoffset', String(circunferencia * (1 - (percentual / 100))));
  }

  function adicionarLinhaLog(progresso = {}) {
    const resultado = tipoDoResultado(progresso.statusEnvio || 'Erro');
    log.querySelector('#log-vazio')?.remove();
    log.appendChild(paraElemento(`<div class="linha-log"><span aria-hidden="true">${resultado.icone}</span><span>${escaparHtml(progresso.cliente?.nome || 'Cliente')}</span><span class="badge badge--${resultado.tom}">${resultado.nome}</span><span class="tel">${escaparHtml(formatarTelefone(progresso.cliente?.telefone))}</span></div>`));
  }

  (Array.isArray(progressoSalvo.registros) ? progressoSalvo.registros : []).forEach(adicionarLinhaLog);
  atualizarResumo();

  const cancelarAssinatura = api.onCampaignProgress((progresso = {}) => {
    if (!tela.isConnected || finalizado) return;
    const resultado = tipoDoResultado(progresso.statusEnvio || 'Erro');
    if (resultado.tom === 'sucesso') enviados += 1;
    else if (resultado.tom === 'neutro') ignorados += 1;
    else erros += 1;
    adicionarLinhaLog(progresso);
    const registros = [...(Array.isArray(campanha.progresso?.registros) ? campanha.progresso.registros : []), {
      statusEnvio: String(progresso.statusEnvio || ''),
      cliente: {
        nome: String(progresso.cliente?.nome || ''),
        telefone: String(progresso.cliente?.telefone || ''),
      },
    }].slice(-200);
    campanha.progresso = { enviados, erros, ignorados, registros };
    log.scrollTop = log.scrollHeight;
    atualizarResumo();
  });
  const removerProgresso = typeof cancelarAssinatura === 'function' ? cancelarAssinatura : () => {};
  let removerConclusao = () => {};
  const removerAssinaturas = () => {
    removerProgresso();
    removerConclusao();
  };
  const removerAoTrocarRota = () => removerAssinaturas();
  window.addEventListener('hashchange', removerAoTrocarRota, { once: true });

  async function encerrar(resultado, erro) {
    if (finalizado) return;
    finalizado = true;
    removerAssinaturas();
    window.removeEventListener('hashchange', removerAoTrocarRota);
    botaoPausar.disabled = true;
    botaoCancelar.disabled = true;
    if (erro) {
      campanha.iniciada = false;
      const mensagem = String(erro?.message || erro || 'O envio não foi concluído.');
      log.querySelector('#log-vazio')?.remove();
      log.appendChild(paraElemento(`<p role="alert" style="padding:16px;color:var(--vv-erro)">${escaparHtml(mensagem)}</p>`));
      mostrarToast(mensagem, 'erro');
      return;
    }

    let atualizouHistorico = true;
    try {
      const relatorios = await api.listReports();
      estado.historico = Array.isArray(relatorios) ? relatorios : [];
    } catch {
      atualizouHistorico = false;
    }
    estado.campanhaEmAndamento = null;
    if (atualizouHistorico) {
      mostrarToast(resultado?.cancelado ? 'Campanha cancelada e relatório salvo.' : 'Campanha concluída e relatório salvo.', resultado?.cancelado ? 'aviso' : 'sucesso');
    } else {
      mostrarToast('A campanha terminou, mas o histórico não pôde ser atualizado agora.', 'aviso');
    }
    if (tela.isConnected) setTimeout(() => { if (tela.isConnected) navegar('historico'); }, 700);
  }

  botaoPausar.addEventListener('click', async () => {
    const proximoEstado = !pausado;
    try {
      botaoPausar.disabled = true;
      botaoPausar.setAttribute('aria-busy', 'true');
      await api.pauseCampaign(proximoEstado);
      pausado = proximoEstado;
      botaoPausar.setAttribute('aria-pressed', String(pausado));
      botaoPausar.innerHTML = pausado ? `${Icone.play} Retomar` : `${Icone.pausa} Pausar`;
    } catch (error) {
      mostrarToast(error.message || 'Não foi possível alterar a campanha.', 'erro');
    } finally {
      botaoPausar.removeAttribute('aria-busy');
      if (!finalizado) botaoPausar.disabled = false;
    }
  });

  botaoCancelar.addEventListener('click', async () => {
    if (!confirm('Cancelar o envio? Os resultados já processados serão salvos em relatório.')) return;
    try {
      botaoCancelar.disabled = true;
      botaoCancelar.setAttribute('aria-busy', 'true');
      botaoCancelar.textContent = 'Cancelando...';
      await api.cancelCampaign();
    } catch (error) {
      botaoCancelar.disabled = false;
      botaoCancelar.removeAttribute('aria-busy');
      botaoCancelar.textContent = 'Cancelar';
      mostrarToast(error.message || 'Não foi possível cancelar a campanha.', 'erro');
    }
  });

  const cancelarConclusao = api.onCampaignFinished((resultado) => encerrar(resultado));
  removerConclusao = typeof cancelarConclusao === 'function' ? cancelarConclusao : () => {};

  if (!campanha.iniciada) {
    campanha.iniciada = true;
    api.startCampaign(campanha).then((resultado) => encerrar(resultado)).catch((error) => encerrar(null, error));
  }
}
