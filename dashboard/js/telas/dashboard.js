import { estado, formatarMoeda, formatarData, calcularEnviosSemana } from '../nucleo/estado.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

function graficoSemana(dados) {
  const max = Math.max(...dados.map((d) => d.enviados)) || 1;
  const larguraBarra = 34, gap = 26, altura = 130;
  const svgBarras = dados.map((d, i) => {
    const x = i * (larguraBarra + gap);
    const hEnv = (d.enviados / max) * altura;
    const hErr = (d.erros / max) * altura;
    return `
      <rect x="${x}" y="${altura - hEnv}" width="${larguraBarra}" height="${hEnv}" rx="4" fill="#3E6650"/>
      <rect x="${x}" y="${altura - hEnv - hErr - 3}" width="${larguraBarra}" height="${hErr}" rx="4" fill="#B34A3D"/>
      <text x="${x + larguraBarra/2}" y="${altura + 18}" font-size="11" fill="#5B6459" text-anchor="middle">${d.dia}</text>
    `;
  }).join('');
  const largura = dados.length * (larguraBarra + gap);
  return `<svg viewBox="0 0 ${largura} ${altura + 30}" width="100%" height="170">${svgBarras}</svg>`;
}

export function montarDashboard(alvo) {
  const totalClientes = estado.clientes.length;
  const devedores = estado.clientes.filter((c) => c.status === 'devedor');
  const valorAberto = devedores.reduce((s, c) => s + (Number(c.valorDevido) || 0), 0);
  const historicoOrdenado = [...estado.historico].sort((a, b) => new Date(b.data) - new Date(a.data));
  const ultimaCampanha = historicoOrdenado[0];
  const dadosSemana = estado.historico.length ? calcularEnviosSemana(estado.historico) : calcularEnviosSemana([]);

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Visão geral</h1><p class="legenda">Resumo das cobranças e campanhas registradas na base local</p></div>
      </div>

      <div class="grade-resumo">
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.clientes} Clientes cadastrados</div><div class="valor">${totalClientes}</div><div class="rodape">base ativa</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.alerta} Com saldo devedor</div><div class="valor">${devedores.length}</div><div class="rodape">${totalClientes ? ((devedores.length/totalClientes)*100).toFixed(0) : 0}% da base</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.cifrao} Valor total em aberto</div><div class="valor">${formatarMoeda(valorAberto)}</div><div class="rodape">a receber</div></div>
        <div class="cartao cartao-metrica"><div class="rotulo">${Icone.relogio} Última campanha</div><div class="valor" style="font-size:18px">${ultimaCampanha ? formatarData(ultimaCampanha.data).split(' ')[0] : '—'}</div><div class="rodape">${ultimaCampanha ? `${ultimaCampanha.total} destinatários` : 'nenhuma campanha registrada'}</div></div>
      </div>

      <div class="grade-acoes">
        <button class="cartao acao-grande cobranca" id="acao-cobranca">
          <span class="icone">${Icone.alerta}</span>
          <span><h3>Nova cobrança</h3><p>Enviar lembrete só para quem está devendo</p></span>
        </button>
        <button class="cartao acao-grande campanha" id="acao-campanha">
          <span class="icone">${Icone.campanha}</span>
          <span><h3>Nova campanha promocional</h3><p>Enviar oferta para todos os clientes</p></span>
        </button>
      </div>

      <div class="cartao painel-grafico">
        <div class="cabecalho">
          <h3>Envios registrados</h3>
          <div class="legenda-grafico"><span><i style="background:#3E6650"></i>Enviados</span><span><i style="background:#B34A3D"></i>Erros</span></div>
        </div>
        ${estado.historico.length ? graficoSemana(dadosSemana) : `<div class="estado-vazio">${Icone.historico}<p>Ainda não há relatórios salvos para montar o gráfico.</p></div>`}
      </div>
    </div>`);
  alvo.appendChild(tela);

  tela.querySelector('#acao-cobranca').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'cobranca'; navegar('nova-campanha'); });
  tela.querySelector('#acao-campanha').addEventListener('click', () => { estado.novaCampanhaTipoInicial = 'promocao'; navegar('nova-campanha'); });
}
