import { estado, formatarTelefone, persistirEstado } from '../nucleo/estado.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento, mostrarToast } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const RESULTADOS = [
  { chave: 'enviado', peso: 0.9, rotulo: 'Enviado', icone: Icone.check, cor: 'var(--vv-sucesso)' },
  { chave: 'erro', peso: 0.07, rotulo: 'Erro', icone: Icone.x, cor: 'var(--vv-erro)' },
  { chave: 'ignorado', peso: 0.03, rotulo: 'Ignorado', icone: Icone.aviso, cor: 'var(--vv-neutro)' },
];
function sortearResultado() {
  const r = Math.random();
  let acc = 0;
  for (const item of RESULTADOS) { acc += item.peso; if (r <= acc) return item; }
  return RESULTADOS[0];
}

function salvarHistorico(campanha, total, enviados, erros, ignorados) {
  estado.historico.unshift({
    id: Date.now(),
    data: new Date().toISOString(),
    tipo: campanha.tipo,
    total,
    enviados,
    erros,
    ignorados,
  });
  estado.campanhaEmAndamento = null;
  persistirEstado();
}

export function montarEnvio(alvo) {
  const campanha = estado.campanhaEmAndamento;
  if (!campanha) {
    alvo.appendChild(paraElemento(`<div class="estado-vazio">${Icone.campanha}<p>Nenhum envio em andamento. Inicie uma campanha primeiro.</p></div>`));
    return;
  }

  const total = campanha.destinatarios.length;
  let enviados = 0, comErro = 0, ignorados = 0;
  let pausado = false, cancelado = false;
  const raio = 62, circ = 2 * Math.PI * raio;

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Envio em andamento</h1><p class="legenda">${campanha.tipo === 'cobranca' ? 'Campanha de cobrança' : 'Campanha promocional'} · ${total} destinatários</p></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn--secundario" id="btn-pausar">${Icone.pausa} Pausar</button>
          <button class="btn btn--perigo" id="btn-cancelar">Cancelar</button>
        </div>
      </div>

      <div class="cartao" style="padding:26px;display:flex;gap:34px;align-items:center;flex-wrap:wrap;margin-bottom:20px">
        <div class="anel-progresso">
          <svg width="150" height="150" viewBox="0 0 150 150">
            <circle cx="75" cy="75" r="${raio}" stroke="#E2DFD2" stroke-width="12" fill="none"/>
            <circle id="circulo-progresso" cx="75" cy="75" r="${raio}" stroke="#3E6650" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"/>
          </svg>
          <div class="texto"><strong id="txt-contagem">0/${total}</strong><span id="txt-percentual">0%</span></div>
        </div>
        <div style="flex:1;min-width:200px;display:flex;gap:24px">
          <div><div class="rotulo" style="font-size:12.5px;color:var(--vv-texto-sutil);font-weight:600">${Icone.check} Enviados</div><div class="valor" style="font-size:22px;font-family:var(--vv-fonte-titulo)" id="txt-enviados">0</div></div>
          <div><div class="rotulo" style="font-size:12.5px;color:var(--vv-texto-sutil);font-weight:600">${Icone.x} Erros</div><div class="valor" style="font-size:22px;font-family:var(--vv-fonte-titulo)" id="txt-erros">0</div></div>
          <div><div class="rotulo" style="font-size:12.5px;color:var(--vv-texto-sutil);font-weight:600">${Icone.aviso} Ignorados</div><div class="valor" style="font-size:22px;font-family:var(--vv-fonte-titulo)" id="txt-ignorados">0</div></div>
        </div>
      </div>

      <div class="cartao">
        <div style="padding:14px 16px;border-bottom:1px solid var(--vv-linha);font-weight:600;font-size:14px">Log de envio</div>
        <div class="log-envio" id="log-envio"></div>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const circulo = tela.querySelector('#circulo-progresso');
  const log = tela.querySelector('#log-envio');
  const btnPausar = tela.querySelector('#btn-pausar');

  function atualizarResumo() {
    tela.querySelector('#txt-contagem').textContent = `${enviados + comErro + ignorados}/${total}`;
    tela.querySelector('#txt-percentual').textContent = `${Math.round(((enviados + comErro + ignorados) / total) * 100)}%`;
    tela.querySelector('#txt-enviados').textContent = enviados;
    tela.querySelector('#txt-erros').textContent = comErro;
    tela.querySelector('#txt-ignorados').textContent = ignorados;
    const progresso = (enviados + comErro + ignorados) / total;
    circulo.setAttribute('stroke-dashoffset', String(circ * (1 - progresso)));
  }

  function processarProximo(indice) {
    if (cancelado || indice >= total) {
      if (!cancelado) finalizar();
      return;
    }
    if (pausado) { setTimeout(() => processarProximo(indice), 400); return; }

    const cliente = campanha.destinatarios[indice];
    const resultado = sortearResultado();
    if (resultado.chave === 'enviado') enviados++; else if (resultado.chave === 'erro') comErro++; else ignorados++;

    const linha = paraElemento(`
      <div class="linha-log">
        <span style="color:${resultado.cor}">${resultado.icone}</span>
        <span>${cliente.nome}</span>
        <span class="badge badge--${resultado.chave === 'enviado' ? 'sucesso' : resultado.chave === 'erro' ? 'erro' : 'neutro'}">${resultado.rotulo}</span>
        <span class="tel">${formatarTelefone(cliente.telefone)}</span>
      </div>`);
    log.appendChild(linha);
    log.scrollTop = log.scrollHeight;
    atualizarResumo();

    setTimeout(() => processarProximo(indice + 1), 90);
  }

  function finalizar() {
    mostrarToast('Campanha concluída', 'sucesso');
    salvarHistorico(campanha, total, enviados, comErro, ignorados);
    setTimeout(() => navegar('historico'), 900);
  }

  btnPausar.addEventListener('click', () => {
    pausado = !pausado;
    btnPausar.innerHTML = pausado ? `${Icone.play} Retomar` : `${Icone.pausa} Pausar`;
  });
  tela.querySelector('#btn-cancelar').addEventListener('click', () => {
    if (!confirm('Cancelar o envio em andamento? O progresso até aqui será registrado no histórico.')) return;
    cancelado = true;
    mostrarToast('Envio cancelado pelo usuário', 'aviso');
    salvarHistorico(campanha, total, enviados, comErro, total - enviados - comErro);
    setTimeout(() => navegar('historico'), 700);
  });

  processarProximo(0);
}
