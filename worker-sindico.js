// "Porteiro" do painel do síndico — roda no Cloudflare Workers (grátis).
//
// Ele guarda a chave do GitHub em segredo. O síndico entra com usuário e senha
// e só consegue mexer nos COMUNICADOS. Propagandas e configurações ficam intocáveis.
//
// Segredos a cadastrar no Cloudflare (Settings > Variables > Encrypt):
//   GITHUB_TOKEN    — chave fine-grained com Contents read/write no repositório
//   SINDICO_USUARIO — ex.: sindico
//   SINDICO_SENHA   — a senha que você entrega ao síndico
//   SEGREDO         — qualquer frase longa e aleatória (assina o crachá de acesso)

const REPO = 'onmidiascreen-dotcom/onmidiascreen-dotcom.github.io';
const GH = 'https://api.github.com/repos/' + REPO + '/contents/';
// endereços autorizados a falar com o porteiro (o antigo do GitHub e o domínio próprio).
// Mantemos os dois para a migração de domínio não derrubar o painel do síndico.
const ORIGENS = [
  'https://onmidiascreen-dotcom.github.io',
  'https://onscreenmidia.com.br',
  'https://www.onscreenmidia.com.br',
];
const origemPermitida = (req) => {
  const o = req.headers.get('Origin') || '';
  return ORIGENS.includes(o) ? o : ORIGENS[0];
};
const HORAS_DE_ACESSO = 12;
const MAX_IMAGEM_MB = 5;

// ---------- utilidades ----------
const enc = new TextEncoder();
const utf8ToB64 = (s) => { let bin = ''; enc.encode(s).forEach((b) => bin += String.fromCharCode(b)); return btoa(bin); };
const b64ToUtf8 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

function cors(resp, origem) {
  resp.headers.set('Access-Control-Allow-Origin', origem);
  resp.headers.set('Vary', 'Origin');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  resp.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  return resp;
}
// o CORS é aplicado uma vez só, no fim da requisição (assim json() não precisa saber da origem)
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' }
});

// compara sem vazar tempo (evita adivinhação de senha por cronômetro)
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- crachá de acesso (token assinado) ----------
async function hmac(texto, segredo) {
  const k = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(texto));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
async function criarCracha(segredo) {
  const exp = String(Date.now() + HORAS_DE_ACESSO * 3600e3);
  return exp + '.' + await hmac(exp, segredo);
}
async function crachaValido(cracha, segredo) {
  if (!cracha) return false;
  const [exp, sig] = cracha.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return igual(sig, await hmac(exp, segredo));
}
const autorizado = (req, env) => crachaValido((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env.SEGREDO);

// ---------- GitHub ----------
function ghHeaders(env) {
  return {
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OnScreen-Sindico',
    'Content-Type': 'application/json'
  };
}
async function lerConfig(env) {
  const r = await fetch(GH + 'config.json', { headers: ghHeaders(env) });
  if (!r.ok) throw new Error('nao consegui ler o conteudo (' + r.status + ')');
  const j = await r.json();
  return { cfg: JSON.parse(b64ToUtf8(j.content)), sha: j.sha };
}

// estrutura nova: cada prédio tem suas telas e seus comunicados.
// Converte o formato antigo (prédio único na raiz), por segurança.
function normalizarCfg(cfg) {
  if (!Array.isArray(cfg.predios)) {
    cfg.predios = [{
      id: 'principal',
      nome: cfg.predio || 'OnScreen',
      cidade: cfg.cidade || null,
      telas: [],
      comunicados: cfg.comunicados || []
    }];
    delete cfg.predio; delete cfg.cidade; delete cfg.comunicados;
  }
  cfg.predios.forEach((p) => { p.comunicados = p.comunicados || []; });
  return cfg;
}

// qual prédio este síndico administra: o id no segredo SINDICO_PREDIO, ou o primeiro da lista.
// (com mais prédios, cada síndico ganha o seu worker/segredo apontando para o prédio dele)
function indicePredio(cfg, env) {
  const alvo = (env.SINDICO_PREDIO || '').trim();
  if (alvo) {
    const i = cfg.predios.findIndex((p) => p.id === alvo);
    if (i >= 0) return i;
  }
  return 0;
}

// cartazes em uso em TODOS os prédios — senão o síndico de um prédio apagaria o cartaz de outro
function cartazesEmUso(cfg) {
  const usados = new Set();
  cfg.predios.forEach((p) => (p.comunicados || []).forEach((n) => { if (n.imagem) usados.add(n.imagem); }));
  return usados;
}

// só deixa passar o que é comunicado de verdade — nada de campo estranho
function limparComunicados(lista) {
  if (!Array.isArray(lista)) throw new Error('formato invalido');
  if (lista.length > 20) throw new Error('maximo de 20 comunicados');
  return lista.map((n) => {
    const limpo = {};
    if (typeof n.imagem === 'string' && /^comunicados\/[\w.\- ]+$/.test(n.imagem)) limpo.imagem = n.imagem;
    if (typeof n.titulo === 'string') limpo.titulo = n.titulo.slice(0, 120);
    if (typeof n.texto === 'string') limpo.texto = n.texto.slice(0, 600);
    const s = Number(n.segundos);
    if (s >= 3 && s <= 120) limpo.segundos = Math.round(s);
    if (!limpo.imagem && !limpo.titulo) throw new Error('comunicado sem titulo nem imagem');
    return limpo;
  });
}

const FONTES_VALIDAS = ['g1', 'uol', 'cnn'];

// Preferências de exibição do síndico: notícias, curiosidades e a fonte das notícias.
// "exibirAnuncios" de propósito NÃO tem entrada aqui — mesmo que alguém injete esse
// campo no corpo da requisição, ele é ignorado (allowlist, não blocklist).
function limparPreferencias(p) {
  if (!p || typeof p !== 'object') return {};
  const limpo = {};
  if (typeof p.exibirNoticias === 'boolean') limpo.exibirNoticias = p.exibirNoticias;
  if (typeof p.exibirCuriosidades === 'boolean') limpo.exibirCuriosidades = p.exibirCuriosidades;
  if (typeof p.fonteNoticias === 'string') {
    if (p.fonteNoticias === '' || FONTES_VALIDAS.includes(p.fonteNoticias)) limpo.fonteNoticias = p.fonteNoticias;
  }
  return limpo;
}

// apaga cartazes que ninguém usa mais (a memória não cresce à toa)
async function limparCartazesOrfaos(env, usados) {
  const r = await fetch(GH + 'comunicados', { headers: ghHeaders(env) });
  if (!r.ok) return;
  const arquivos = await r.json();
  if (!Array.isArray(arquivos)) return;
  for (const a of arquivos) {
    if (a.type !== 'file' || /^(LEIA-ME|\.gitkeep)/i.test(a.name)) continue;
    if (usados.has(a.path)) continue;
    await fetch(GH + a.path, {
      method: 'DELETE', headers: ghHeaders(env),
      body: JSON.stringify({ message: 'sindico: remove cartaz sem uso ' + a.path, sha: a.sha })
    });
  }
}

// ---------- monitoramento das telas ----------
// Cada tela manda um "estou viva" de tempos em tempos e, mais espaçado, uma foto
// do que está mostrando. Serve para o dono ver, de casa, se a tela do elevador
// está no ar — sem depender do painel de ninguém.
//
// Guarda no D1 (banco grátis do Cloudflare). Precisa do bind DB no wrangler.toml
// e do segredo MONITOR_TOKEN (senha só do dono, para LER o monitoramento).
const MAX_CAPTURA_KB = 400;
const CAPTURAS_POR_TELA = 12;   // ~6h de histórico com foto a cada 30 min
const idValido = (s) => typeof s === 'string' && /^[a-z0-9-]{1,40}$/.test(s);

// o dono lê o monitoramento com um token próprio (as telas escrevem sem token)
const ehDono = (req, env) =>
  !!env.MONITOR_TOKEN &&
  igual((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env.MONITOR_TOKEN);

// cria as tabelas na primeira chamada (idempotente, barato)
async function prepararBanco(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sinais (
      tela TEXT PRIMARY KEY, predio TEXT, ultimo_sinal INTEGER NOT NULL, dados TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS capturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tela TEXT NOT NULL,
      ts INTEGER NOT NULL, imagem TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_capturas ON capturas (tela, ts DESC)`)
  ]);
}

// só guarda o que interessa — a tela manda o que quiser, nós filtramos
function limparDados(d) {
  if (!d || typeof d !== 'object') return {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    online: !!d.online,
    versaoApp: String(d.versaoApp || '').slice(0, 20),
    anuncios: n(d.anuncios),
    comunicados: n(d.comunicados),
    noticias: n(d.noticias),
    noticiaEm: n(d.noticiaEm),          // quando as notícias foram geradas
    sincronizadoEm: n(d.sincronizadoEm), // último contato com a internet
    ligadaHa: n(d.ligadaHa),             // minutos desde que o player abriu
    tela: String(d.telaTam || '').slice(0, 20),
    erro: String(d.erro || '').slice(0, 200)
  };
}

export { limparDados }; // usado pelos testes

// ---------- rotas ----------
export default {
  async fetch(req, env) {
    // qualquer resposta sai com o CORS do endereço que pediu (se for um dos autorizados)
    return cors(await tratar(req, env), origemPermitida(req));
  }
};

async function tratar(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    const rota = new URL(req.url).pathname.replace(/\/+$/, '');

    try {
      if (rota === '/login' && req.method === 'POST') {
        const { usuario, senha } = await req.json();
        if (!igual(usuario || '', env.SINDICO_USUARIO) || !igual(senha || '', env.SINDICO_SENHA)) {
          await new Promise((r) => setTimeout(r, 700)); // atrasa quem fica tentando
          return json({ erro: 'Usuário ou senha incorretos.' }, 401);
        }
        return json({ cracha: await criarCracha(env.SEGREDO) });
      }

      // ----- monitoramento (não passa pelo crachá do síndico) -----
      // as telas escrevem sem senha: elas ficam em elevador, não dá para guardar
      // segredo nelas. O risco é alguém inventar um sinal falso — não estraga nada.
      if (rota === '/ping' && req.method === 'POST') {
        if (!env.DB) return json({ erro: 'Monitoramento não configurado.' }, 501);
        const b = await req.json();
        if (!idValido(b.tela)) return json({ erro: 'Tela inválida.' }, 400);
        await prepararBanco(env);
        await env.DB.prepare(
          `INSERT INTO sinais (tela, predio, ultimo_sinal, dados) VALUES (?, ?, ?, ?)
           ON CONFLICT(tela) DO UPDATE SET predio=excluded.predio,
             ultimo_sinal=excluded.ultimo_sinal, dados=excluded.dados`
        ).bind(
          b.tela,
          idValido(b.predio) ? b.predio : '',
          Date.now(),
          JSON.stringify(limparDados(b.dados))
        ).run();
        return json({ ok: true });
      }

      if (rota === '/captura' && req.method === 'POST') {
        if (!env.DB) return json({ erro: 'Monitoramento não configurado.' }, 501);
        const b = await req.json();
        if (!idValido(b.tela)) return json({ erro: 'Tela inválida.' }, 400);
        const img = String(b.imagem || '');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) return json({ erro: 'Imagem inválida.' }, 400);
        if (img.length * 0.75 > MAX_CAPTURA_KB * 1024) return json({ erro: 'Imagem grande demais.' }, 400);
        await prepararBanco(env);
        await env.DB.prepare('INSERT INTO capturas (tela, ts, imagem) VALUES (?, ?, ?)')
          .bind(b.tela, Date.now(), img).run();
        // guarda só as últimas — senão o banco cresce para sempre
        await env.DB.prepare(
          `DELETE FROM capturas WHERE tela = ?1 AND id NOT IN
             (SELECT id FROM capturas WHERE tela = ?1 ORDER BY ts DESC LIMIT ?2)`
        ).bind(b.tela, CAPTURAS_POR_TELA).run();
        return json({ ok: true });
      }

      // leitura do monitoramento: só o dono, com o token dele
      if (rota === '/monitor' && req.method === 'GET') {
        if (!env.DB) return json({ erro: 'Monitoramento não configurado.' }, 501);
        if (!ehDono(req, env)) return json({ erro: 'Token do monitoramento inválido.' }, 401);
        await prepararBanco(env);
        const { results } = await env.DB.prepare(
          `SELECT s.tela, s.predio, s.ultimo_sinal, s.dados,
                  (SELECT ts FROM capturas c WHERE c.tela = s.tela ORDER BY ts DESC LIMIT 1) AS captura_em
             FROM sinais s ORDER BY s.ultimo_sinal DESC`
        ).all();
        return json({
          agora: Date.now(),
          telas: (results || []).map((r) => ({
            tela: r.tela, predio: r.predio,
            ultimoSinal: r.ultimo_sinal,
            capturaEm: r.captura_em || null,
            dados: JSON.parse(r.dados || '{}')
          }))
        });
      }

      // fotos de uma tela (pesadas, por isso separadas do /monitor)
      if (rota === '/capturas' && req.method === 'GET') {
        if (!env.DB) return json({ erro: 'Monitoramento não configurado.' }, 501);
        if (!ehDono(req, env)) return json({ erro: 'Token do monitoramento inválido.' }, 401);
        const tela = new URL(req.url).searchParams.get('tela') || '';
        if (!idValido(tela)) return json({ erro: 'Tela inválida.' }, 400);
        await prepararBanco(env);
        const { results } = await env.DB.prepare(
          'SELECT ts, imagem FROM capturas WHERE tela = ? ORDER BY ts DESC LIMIT ?'
        ).bind(tela, CAPTURAS_POR_TELA).all();
        return json({ tela, capturas: results || [] });
      }

      if (!await autorizado(req, env)) return json({ erro: 'Sessão expirada. Entre novamente.' }, 401);

      if (rota === '/comunicados' && req.method === 'GET') {
        const { cfg } = await lerConfig(env);
        normalizarCfg(cfg);
        const p = cfg.predios[indicePredio(cfg, env)] || { nome: '', comunicados: [] };
        return json({
          predio: p.nome || '',
          comunicados: p.comunicados || [],
          // "exibirAnuncios" de propósito NUNCA aparece aqui — propaganda é conteúdo
          // pago, o síndico não pode nem ver essa opção, só o dono (painel próprio).
          preferencias: {
            exibirNoticias: p.exibirNoticias !== false,
            exibirCuriosidades: p.exibirCuriosidades !== false,
            fonteNoticias: p.fonteNoticias || ''
          }
        });
      }

      if (rota === '/comunicados' && req.method === 'PUT') {
        const body = await req.json();
        const comunicados = limparComunicados(body.comunicados);
        const preferencias = limparPreferencias(body.preferencias);
        const { cfg, sha } = await lerConfig(env);
        normalizarCfg(cfg);
        const i = indicePredio(cfg, env);
        if (!cfg.predios[i]) return json({ erro: 'Prédio não encontrado.' }, 400);
        // só os comunicados e as preferências DESTE prédio mudam. Propagandas,
        // outros prédios, e principalmente "exibirAnuncios" ficam intocáveis.
        cfg.predios[i].comunicados = comunicados;
        if ('exibirNoticias' in preferencias) cfg.predios[i].exibirNoticias = preferencias.exibirNoticias;
        if ('exibirCuriosidades' in preferencias) cfg.predios[i].exibirCuriosidades = preferencias.exibirCuriosidades;
        if ('fonteNoticias' in preferencias) {
          if (preferencias.fonteNoticias) cfg.predios[i].fonteNoticias = preferencias.fonteNoticias;
          else delete cfg.predios[i].fonteNoticias; // vazio = volta a usar o padrão do sistema
        }
        const r = await fetch(GH + 'config.json', {
          method: 'PUT', headers: ghHeaders(env),
          body: JSON.stringify({
            message: 'sindico: atualiza comunicados de ' + (cfg.predios[i].nome || cfg.predios[i].id),
            content: utf8ToB64(JSON.stringify(cfg, null, 2)),
            sha
          })
        });
        if (!r.ok) return json({ erro: 'Não consegui publicar (' + r.status + ').' }, 502);
        await limparCartazesOrfaos(env, cartazesEmUso(cfg)); // usa os cartazes de TODOS os prédios
        return json({ ok: true });
      }

      if (rota === '/cartaz' && req.method === 'POST') {
        const { nome, conteudo } = await req.json();
        if (typeof conteudo !== 'string' || !conteudo) return json({ erro: 'Arquivo vazio.' }, 400);
        if (conteudo.length * 0.75 > MAX_IMAGEM_MB * 1024 * 1024) return json({ erro: 'Imagem maior que ' + MAX_IMAGEM_MB + ' MB.' }, 400);
        const seguro = String(nome || 'cartaz').replace(/[^a-zA-Z0-9.\-]/g, '_').slice(-60);
        if (!/\.(jpe?g|png|webp)$/i.test(seguro)) return json({ erro: 'Use JPG, PNG ou WEBP.' }, 400);
        const caminho = 'comunicados/' + Date.now() + '-' + seguro;
        const r = await fetch(GH + caminho, {
          method: 'PUT', headers: ghHeaders(env),
          body: JSON.stringify({ message: 'sindico: cartaz ' + caminho, content: conteudo })
        });
        if (!r.ok) return json({ erro: 'Falha ao enviar o cartaz (' + r.status + ').' }, 502);
        return json({ caminho });
      }

      return json({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      return json({ erro: e.message || 'Erro inesperado.' }, 400);
    }
}
