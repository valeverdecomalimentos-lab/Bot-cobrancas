import { estado, barramento } from '../nucleo/estado.js';
import { navegar } from '../nucleo/roteador.js';
import { paraElemento } from '../nucleo/ui.js';

// gera um padrão determinístico tipo QR — puramente visual, não decodificável.
function svgQrMock() {
  let celulas = '';
  const tam = 21, px = 8;
  let semente = 42;
  const rnd = () => { semente = (semente * 9301 + 49297) % 233280; return semente / 233280; };
  for (let y = 0; y < tam; y++) {
    for (let x = 0; x < tam; x++) {
      const nosCantos = (x < 7 && y < 7) || (x > tam - 8 && y < 7) || (x < 7 && y > tam - 8);
      const pinta = nosCantos ? ([1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,1,1,1].includes((x%7)+(y%7)) || (x%7<7 && y%7<7 && (x%7===0||x%7===6||y%7===0||y%7===6||(x%7>1&&x%7<5&&y%7>1&&y%7<5)))) : rnd() > 0.56;
      if (pinta) celulas += `<rect x="${x*px}" y="${y*px}" width="${px}" height="${px}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${tam*px} ${tam*px}" width="180" height="180" fill="#1F3B2E">${celulas}</svg>`;
}

const CONFIG_STATUS = {
  desconectado: { rotulo: 'Desconectado', cor: 'var(--vv-erro)' },
  aguardando_qr: { rotulo: 'Aguardando leitura do QR Code', cor: 'var(--vv-alerta)' },
  conectado: { rotulo: 'Conectado', cor: 'var(--vv-sucesso)' },
};

export function montarLogin(alvo) {
  const tela = paraElemento(`
    <div class="tela-login">
      <div class="painel-login cartao">
        <div class="marca-login">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1F3B2E" stroke-width="1.8"><path d="M12 21V10"/><path d="M12 10C12 6 9 4 5 4c0 4.2 2.7 7 7 7Z"/><path d="M12 13c0-4.5 3.4-6.7 7.5-6.7-.2 4.9-3.3 7.5-7.5 6.7Z"/></svg>
          <strong>Vale Verde</strong>
          <span>Painel de disparos WhatsApp</span>
        </div>
        <div id="area-status"></div>
      </div>
    </div>`);
  alvo.appendChild(tela);

  const areaStatus = tela.querySelector('#area-status');

  function renderizar() {
    const s = estado.conexaoWhatsapp.status;
    const cfg = CONFIG_STATUS[s];
    if (s === 'conectado') {
      areaStatus.innerHTML = `
        <div class="moldura-qr" style="border-color:var(--vv-sucesso)">
          <svg width="70" height="70" viewBox="0 0 24 24" fill="none" stroke="#3E6650" stroke-width="1.6"><circle cx="12" cy="12" r="9.5"/><path d="M8 12.3l2.5 2.5L16 9"/></svg>
        </div>
        <div class="status-linha"><span class="ponto" style="background:${cfg.cor}"></span> Conectado como <strong>${estado.conexaoWhatsapp.numero}</strong></div>
        <p style="font-size:13px;color:var(--vv-texto-sutil);margin-bottom:18px">Sessão ativa e pronta para disparos.</p>
        <button class="btn btn--primario" id="btn-entrar" style="width:100%">Entrar no painel</button>
      `;
      tela.querySelector('#btn-entrar').addEventListener('click', () => navegar('dashboard'));
    } else if (s === 'aguardando_qr') {
      areaStatus.innerHTML = `
        <div class="moldura-qr">${svgQrMock()}<div class="varredura"></div></div>
        <div class="status-linha"><span class="spinner"></span> ${cfg.rotulo}</div>
        <p style="font-size:13px;color:var(--vv-texto-sutil)">Abra o WhatsApp no celular da empresa → Aparelhos conectados → Conectar um aparelho.</p>
      `;
    } else {
      areaStatus.innerHTML = `
        <div class="moldura-qr"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#B34A3D" stroke-width="1.6"><circle cx="12" cy="12" r="9.5"/><path d="M9 9l6 6M15 9l-6 6"/></svg></div>
        <div class="status-linha"><span class="ponto" style="background:${cfg.cor}"></span> ${cfg.rotulo}</div>
        <button class="btn btn--primario" id="btn-gerar-qr" style="width:100%;margin-top:6px">Gerar QR Code</button>
      `;
      tela.querySelector('#btn-gerar-qr').addEventListener('click', () => {
        estado.conexaoWhatsapp.status = 'aguardando_qr';
        renderizar();
        // simula evento WebSocket "whatsapp:conectado" após a leitura
        setTimeout(() => {
          estado.conexaoWhatsapp = { status: 'conectado', numero: '(22) 99801-4477' };
          barramento.emit('whatsapp:conectado', estado.conexaoWhatsapp);
          renderizar();
        }, 3400);
      });
    }
  }
  renderizar();
}
