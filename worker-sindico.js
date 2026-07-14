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

      if (!await autorizado(req, env)) return json({ erro: 'Sessão expirada. Entre novamente.' }, 401);

      if (rota === '/comunicados' && req.method === 'GET') {
        const { cfg } = await lerConfig(env);
        normalizarCfg(cfg);
        const p = cfg.predios[indicePredio(cfg, env)] || { nome: '', comunicados: [] };
        return json({ predio: p.nome || '', comunicados: p.comunicados || [] });
      }

      if (rota === '/comunicados' && req.method === 'PUT') {
        const body = await req.json();
        const comunicados = limparComunicados(body.comunicados);
        const { cfg, sha } = await lerConfig(env);
        normalizarCfg(cfg);
        const i = indicePredio(cfg, env);
        if (!cfg.predios[i]) return json({ erro: 'Prédio não encontrado.' }, 400);
        // só os comunicados DESTE prédio mudam. Propagandas e os outros prédios ficam intactos.
        cfg.predios[i].comunicados = comunicados;
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
