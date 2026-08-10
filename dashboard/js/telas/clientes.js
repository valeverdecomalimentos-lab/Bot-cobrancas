import { estado, formatarMoeda, formatarTelefone, persistirEstado } from '../nucleo/estado.js';
import { paraElemento, abrirModal, mostrarToast, escaparHtml } from '../nucleo/ui.js';
import { Icone } from '../nucleo/icones.js';

const ROTULO_STATUS = { em_dia: ['Em dia', 'sucesso'], devedor: ['Devedor', 'alerta'], sem_telefone: ['Sem telefone', 'neutro'] };

function limparTexto(valor) {
  return String(valor ?? '').trim();
}

function removerAcentos(valor) {
  return valor.normalize('NFD').replace(/[^\w\s-]/g, '').replace(/_/g, '-').toLowerCase();
}

function slugify(valor) {
  return removerAcentos(valor).trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function normalizarTelefone(valor) {
  const apenasDigitos = String(valor ?? '').replace(/\D/g, '');
  if (!apenasDigitos) return '';
  if (apenasDigitos.length === 11) return `55${apenasDigitos}`;
  if (apenasDigitos.length === 10) return `55${apenasDigitos}`;
  if (apenasDigitos.length > 11 && apenasDigitos.startsWith('55')) return apenasDigitos;
  if (apenasDigitos.length > 11) return `55${apenasDigitos.slice(-11)}`;
  return apenasDigitos;
}

function normalizarValor(valor) {
  const texto = limparTexto(valor);
  if (!texto) return null;
  const valorNumerico = Number(texto.replace(/[\.]/g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isNaN(valorNumerico) ? null : valorNumerico;
}

function normalizarStatus(valor) {
  const texto = limparTexto(valor).toLowerCase();
  if (['devedor', 'devendo', 'atrasado', 'inadimplente', 'em atraso'].includes(texto)) return 'devedor';
  if (['sem telefone', 'sem_telefone', 'sem telefone', 'sem tel', 'sem-contato', 's/telefone'].includes(texto)) return 'sem_telefone';
  if (['em dia', 'em_dia', 'regular', 'quitado', 'pago'].includes(texto)) return 'em_dia';
  return null;
}

function parseCsv(texto) {
  if (!texto) return [];
  const linhas = [];
  let linhaAtual = [];
  let valorAtual = '';
  let entreAspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const char = texto[i];
    if (char === '"') {
      const proximo = texto[i + 1];
      if (entreAspas && proximo === '"') {
        valorAtual += '"';
        i += 1;
      } else {
        entreAspas = !entreAspas;
      }
      continue;
    }

    if (char === ',' && !entreAspas) {
      linhaAtual.push(valorAtual);
      valorAtual = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !entreAspas) {
      if (char === '\r' && texto[i + 1] === '\n') i += 1;
      linhaAtual.push(valorAtual);
      linhas.push(linhaAtual);
      linhaAtual = [];
      valorAtual = '';
      continue;
    }

    valorAtual += char;
  }

  if (valorAtual.length || linhaAtual.length) {
    linhaAtual.push(valorAtual);
    linhas.push(linhaAtual);
  }

  return linhas.filter((linha) => linha.some((coluna) => limparTexto(coluna)));
}

function obterCampo(linha, campo) {
  const valores = Object.values(campo);
  return valores.find((nome) => linha[nome]);
}

export function montarClientes(alvo) {
  let filtroStatus = 'todos';
  let termoBusca = '';

  const tela = paraElemento(`
    <div>
      <div class="topo-pagina">
        <div><h1>Clientes</h1><p class="legenda">${estado.clientes.length} cadastrados</p></div>
        <button class="btn btn--primario" id="btn-importar">${Icone.upload} Importar planilha</button>
      </div>

      <div class="barra-ferramentas">
        <div class="grupo-filtros" id="grupo-filtros">
          <button class="chip-filtro ativo" data-status="todos">Todos</button>
          <button class="chip-filtro" data-status="devedor">Devedores</button>
          <button class="chip-filtro" data-status="em_dia">Em dia</button>
          <button class="chip-filtro" data-status="sem_telefone">Sem telefone</button>
        </div>
        <div class="campo-busca">${Icone.busca}<input type="search" placeholder="Buscar por nome" id="campo-busca"></div>
      </div>

      <div class="cartao" style="overflow:auto">
        <table class="tabela-clientes">
          <thead><tr><th>Nome</th><th>Telefone</th><th>Valor devido</th><th>Status</th></tr></thead>
          <tbody id="corpo-tabela"></tbody>
        </table>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const corpoTabela = tela.querySelector('#corpo-tabela');

  function renderizarLinhas() {
    const filtrados = estado.clientes.filter((c) => {
      const passaStatus = filtroStatus === 'todos' || c.status === filtroStatus;
      const passaBusca = (c.nome || '').toLowerCase().includes(termoBusca.toLowerCase());
      return passaStatus && passaBusca;
    });
    if (!filtrados.length) {
      corpoTabela.innerHTML = `<tr><td colspan="4"><div class="estado-vazio">${Icone.clientes}<p>Nenhum cliente encontrado com esse filtro.</p></div></td></tr>`;
      return;
    }
    corpoTabela.innerHTML = filtrados.map((c) => {
      const [rotulo, tom] = ROTULO_STATUS[c.status] || ['Sem status', 'neutro'];
      return `<tr>
        <td class="celula-nome">${escaparHtml(c.nome)}</td>
        <td>${formatarTelefone(c.telefone)}</td>
        <td class="celula-valor">${c.valorDevido ? formatarMoeda(c.valorDevido) : '—'}</td>
        <td><span class="badge badge--${tom}">${rotulo}</span></td>
      </tr>`;
    }).join('');
  }

  renderizarLinhas();

  tela.querySelector('#grupo-filtros').addEventListener('click', (e) => {
    const botao = e.target.closest('.chip-filtro');
    if (!botao) return;
    tela.querySelectorAll('.chip-filtro').forEach((b) => b.classList.remove('ativo'));
    botao.classList.add('ativo');
    filtroStatus = botao.dataset.status;
    renderizarLinhas();
  });

  tela.querySelector('#campo-busca').addEventListener('input', (e) => {
    termoBusca = e.target.value;
    renderizarLinhas();
  });

  tela.querySelector('#btn-importar').addEventListener('click', () => abrirModalImportacao(renderizarLinhas));
}

function abrirModalImportacao(aoSalvar) {
  const { elemento, fechar } = abrirModal({
    titulo: 'Importar planilha de clientes',
    corpoHtml: `
      <div class="zona-drop" id="zona-drop">
        ${Icone.upload}
        <p style="font-weight:600">Arraste uma tabela CSV aqui</p>
        <p style="font-size:12.5px;color:var(--vv-texto-sutil);margin-top:4px">colunas esperadas: nome, telefone, valor devido, status</p>
        <input type="file" id="arquivo-oculto" accept=".csv,.txt,.tsv" hidden>
      </div>
      <div id="area-preview"></div>
    `,
  });

  const zona = elemento.querySelector('#zona-drop');
  const inputArquivo = elemento.querySelector('#arquivo-oculto');
  const preview = elemento.querySelector('#area-preview');

  const processarArquivo = (arquivo) => {
    if (!arquivo) return;
    zona.innerHTML = `<div class="spinner" style="margin:0 auto"></div><p style="margin-top:10px;font-size:13px;color:var(--vv-texto-sutil)">Importando ${arquivo.name}…</p>`;

    const leitor = new FileReader();
    leitor.onload = () => {
      const linhas = parseCsv(leitor.result);
      if (!linhas.length) {
        zona.style.display = 'none';
        preview.innerHTML = '<p class="estado-vazio">Não foi possível ler linhas válidas no arquivo.</p>';
        return;
      }

      const linhasValidas = linhas.slice(1).filter((linha) => linha.some((coluna) => limparTexto(coluna)));
      const cabecalhos = linhas[0].map((cabecalho) => limparTexto(cabecalho).toLowerCase());
      const indiceNome = cabecalhos.findIndex((valor) => ['nome', 'cliente', 'nome cliente'].includes(valor));
      const indiceTelefone = cabecalhos.findIndex((valor) => ['telefone', 'tel', 'whatsapp', 'celular'].includes(valor));
      const indiceValor = cabecalhos.findIndex((valor) => ['valor devido', 'valor_devido', 'valor devido', 'valor', 'saldo'].includes(valor));
      const indiceStatus = cabecalhos.findIndex((valor) => ['status', 'situacao', 'situação', 'estado'].includes(valor));

      if (indiceNome < 0 || indiceTelefone < 0) {
        zona.style.display = 'none';
        preview.innerHTML = '<p class="estado-vazio">O arquivo não contém colunas compatíveis com nome e telefone.</p>';
        return;
      }

      const total = linhasValidas.length;
      const importados = linhasValidas.map((linha) => {
        const nome = limparTexto(linha[indiceNome] ?? '');
        const telefone = normalizarTelefone(linha[indiceTelefone] ?? '');
        const valor = normalizarValor(linha[indiceValor] ?? '');
        const statusImportado = indiceStatus >= 0 ? normalizarStatus(linha[indiceStatus] ?? '') : null;

        return { nome, telefone, valor, statusImportado };
      }).filter((item) => item.nome || item.telefone);

      zona.style.display = 'none';
      preview.innerHTML = `
        <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <div class="badge badge--sucesso" style="font-size:13px">${importados.length} registros prontos para atualizar</div>
          <div class="badge badge--neutro" style="font-size:13px">${total - importados.length} sem dados úteis</div>
        </div>
        <div class="lista-revisao">
          ${importados.slice(0, 8).map((item) => `<div class="linha-revisao">${Icone.clientes}<span>${escaparHtml(item.nome || 'Cliente sem nome')}</span><span style="margin-left:auto;color:var(--vv-texto-sutil)">${item.telefone ? formatarTelefone(item.telefone) : 'Sem telefone'}</span></div>`).join('')}
        </div>`;

      const rodape = document.createElement('div');
      rodape.className = 'modal-rodape';
      rodape.innerHTML = `<button class="btn btn--secundario" data-cancelar>Cancelar</button><button class="btn btn--primario" data-confirmar>Confirmar importação (${importados.length})</button>`;
      elemento.querySelector('.modal').appendChild(rodape);
      rodape.querySelector('[data-cancelar]').addEventListener('click', fechar);
      rodape.querySelector('[data-confirmar]').addEventListener('click', () => {
        aplicarImportacao(importados);
        fechar();
        aoSalvar?.();
        mostrarToast(`${importados.length} clientes atualizados com sucesso`, 'sucesso');
      });
    };

    leitor.readAsText(arquivo);
  };

  zona.addEventListener('click', () => inputArquivo.click());
  inputArquivo.addEventListener('change', () => {
    const arquivo = inputArquivo.files?.[0];
    if (arquivo) processarArquivo(arquivo);
  });
  ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('arrastando'); }));
  ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('arrastando'); }));
  zona.addEventListener('drop', (e) => {
    const arquivo = e.dataTransfer.files?.[0];
    if (arquivo) processarArquivo(arquivo);
  });
}

function aplicarImportacao(importados) {
  importados.forEach((item) => {
    const chave = item.telefone || slugify(item.nome || 'cliente');
    const clienteExistente = estado.clientes.find((cliente) => {
      if (item.telefone && cliente.telefone) return cliente.telefone === item.telefone;
      return slugify(cliente.nome || '') === slugify(item.nome || '');
    });

    if (clienteExistente) {
      clienteExistente.nome = item.nome || clienteExistente.nome;
      if (item.telefone) clienteExistente.telefone = item.telefone;
      if (item.valor !== null) clienteExistente.valorDevido = item.valor;
      if (item.statusImportado) clienteExistente.status = item.statusImportado;
      if (!clienteExistente.telefone && item.telefone) clienteExistente.telefone = item.telefone;
      if (!clienteExistente.valorDevido && item.valor !== null) clienteExistente.valorDevido = item.valor;
      return;
    }

    estado.clientes.push({
      id: `cliente-${chave}`,
      nome: item.nome || `Cliente ${estado.clientes.length + 1}`,
      telefone: item.telefone,
      valorDevido: item.valor ?? 0,
      status: item.statusImportado || (item.telefone ? 'em_dia' : 'sem_telefone'),
    });
  });

  estado.clientes.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  persistirEstado();
}
