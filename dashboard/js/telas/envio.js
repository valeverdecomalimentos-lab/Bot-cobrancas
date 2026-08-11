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
    alvo.appendChild(paraElemento(`<div class="estado-vazio">${Icone.campanha}<p>Nenhuma campanha ativa.</p></div>`));
    return;
  }

  const total = Number(campanha.totalPlanejado || campanha.recipientIds?.length || 0);
  const raio = 62;
  const circunferencia = 2 * Math.PI * raio;
  let enviados = 0;
  let erros = 0;
  let ignorados = 0;
  let finalizado = false;
  let pausado = false;

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Envio em andamento</h1><p class="legenda">${campanha.tipo === 'cobranca' ? 'Campanha de cobranca' : 'Campanha promocional'} · ${total} destinatarios planejados</p></div>
        <div style="display:flex;gap:10px"><button class="btn btn--secundario" id="btn-pausar">${Icone.pausa} Pausar</button><button class="btn btn--perigo" id="btn-cancelar">Cancelar</button></div>
      </div>
      <div class="cartao" style="padding:26px;display:flex;gap:34px;align-items:center;flex-wrap:wrap;margin-bottom:20px">
        <div class="anel-progresso">
          <svg width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="${raio}" stroke="#D6E0D6" stroke-width="12" fill="none"/><circle id="circulo-progresso" cx="75" cy="75" r="${raio}" stroke="#3E6650" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${circunferencia}" stroke-dashoffset="${circunferencia}"/></svg>
          <div class="texto"><strong id="txt-contagem">0/${total}</strong><span id="txt-percentual">0%</span></div>
        </div>
        <div style="flex:1;min-width:200px;display:flex;gap:24px"><div><div class="rotulo">${Icone.check} Enviados</div><div class="valor" id="txt-enviados">0</div></div><div><div class="rotulo">${Icone.x} Erros</div><div class="valor" id="txt-erros">0</div></div><div><div class="rotulo">${Icone.aviso} Ignorados</div><div class="valor" id="txt-ignorados">0</div></div></div>
      </div>
      <div class="cartao"><div style="padding:14px 16px;border-bottom:1px solid var(--vv-linha);font-weight:600;font-size:14px">Log de envio</div><div class="log-envio" id="log-envio"></div></div>
    </div>`);
  alvo.appendChild(tela);
  const log = tela.querySelector('#log-envio');

  function quantidadeProcessada() {
    return enviados + erros + ignorados;
  }

  function atualizarResumo() {
    const processados = quantidadeProcessada();
    const percentual = total ? Math.round((processados / total) * 100) : 0;
    tela.querySelector('#txt-contagem').textContent = `${processados}/${total}`;
    tela.querySelector('#txt-percentual').textContent = `${percentual}%`;
    tela.querySelector('#txt-enviados').textContent = enviados;
    tela.querySelector('#txt-erros').textContent = erros;
    tela.querySelector('#txt-ignorados').textContent = ignorados;
    tela.querySelector('#circulo-progresso').setAttribute('stroke-dashoffset', String(circunferencia * (1 - (total ? processados / total : 0))));
  }

  const removerProgresso = api.onCampaignProgress((progresso) => {
    if (!tela.isConnected || finalizado) return;
    const resultado = tipoDoResultado(progresso.statusEnvio || 'Erro');
    if (resultado.tom === 'sucesso') enviados += 1;
    else if (resultado.tom === 'neutro') ignorados += 1;
    else erros += 1;
    log.appendChild(paraElemento(`<div class="linha-log"><span>${resultado.icone}</span><span>${escaparHtml(progresso.cliente?.nome || 'Cliente')}</span><span class="badge badge--${resultado.tom}">${resultado.nome}</span><span class="tel">${formatarTelefone(progresso.cliente?.telefone)}</span></div>`));
    log.scrollTop = log.scrollHeight;
    atualizarResumo();
  });

  async function encerrar(resultado, erro) {
    if (finalizado) return;
    finalizado = true;
    removerProgresso();
    tela.querySelector('#btn-pausar').disabled = true;
    tela.querySelector('#btn-cancelar').disabled = true;
    if (erro) {
      campanha.iniciada = false;
      mostrarToast(erro.message || 'O envio nao foi concluido.', 'erro');
      return;
    }
    estado.historico = await api.listReports();
    estado.campanhaEmAndamento = null;
    mostrarToast(resultado?.cancelado ? 'Campanha cancelada e relatorio salvo.' : 'Campanha concluida e relatorio salvo.', resultado?.cancelado ? 'aviso' : 'sucesso');
    setTimeout(() => navegar('historico'), 700);
  }

  tela.querySelector('#btn-pausar').addEventListener('click', async () => {
    try {
      pausado = !pausado;
      await api.pauseCampaign(pausado);
      tela.querySelector('#btn-pausar').innerHTML = pausado ? `${Icone.play} Retomar` : `${Icone.pausa} Pausar`;
    } catch (error) {
      pausado = !pausado;
      mostrarToast(error.message || 'Nao foi possivel alterar a campanha.', 'erro');
    }
  });
  tela.querySelector('#btn-cancelar').addEventListener('click', async () => {
    if (!confirm('Cancelar o envio? Os resultados ja processados serao salvos em relatorio.')) return;
    try {
      await api.cancelCampaign();
      tela.querySelector('#btn-cancelar').disabled = true;
      tela.querySelector('#btn-cancelar').textContent = 'Cancelando...';
    } catch (error) {
      mostrarToast(error.message || 'Nao foi possivel cancelar a campanha.', 'erro');
    }
  });

  if (!campanha.iniciada) {
    campanha.iniciada = true;
    api.startCampaign(campanha).then((resultado) => encerrar(resultado)).catch((error) => encerrar(null, error));
  }
}
