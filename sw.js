// Service Worker: grava o player na memória da tela.
// A tela liga e abre o player mesmo sem internet; a rede só serve para atualizar.
// O player mora em /tela/. A landing (raiz), o painel e o síndico NÃO passam por aqui.
const CACHE = 'onscreen-v9';
const SHELL = ['/tela/', '/tela/index.html', '/manifest.json'];
// cada prédio pode ter sua própria fonte de notícias (noticias-g1.json,
// noticias-uol.json, noticias-cnn.json); /noticias.json continua valendo
// como alias do padrão do sistema, para não quebrar telas com cache antigo.
const ehArquivoDeNoticias = (path) => /^\/noticias(-[a-z0-9]+)?\.json$/.test(path);

// o player pede para guardar vídeos/imagens na memória enquanto tem internet,
// para que rodem mesmo depois que a internet cair
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.tipo !== 'guardar' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // guarda o que está no ar hoje
    for (const u of d.urls) {
      const existe = await c.match(u, { ignoreSearch: true });
      if (existe) continue;
      // baixa manualmente (em vez de c.add) para poder conferir se o arquivo
      // veio inteiro antes de guardar. Sem isso, uma queda de rede no meio do
      // download podia gravar uma cópia cortada — e como ela "existe" no
      // cache, o player nunca mais tentava baixar de novo, mesmo com a
      // internet de volta (foi o que travou uma tela a noite inteira em
      // 03/09, sem gerar erro nenhum no sinal de vida).
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) continue;
        const tamanhoEsperado = Number(r.headers.get('content-length') || 0);
        const blob = await r.clone().blob();
        if (tamanhoEsperado > 0 && blob.size !== tamanhoEsperado) continue; // veio cortado: não guarda, tenta de novo no próximo ciclo
        await c.put(u, r);
      } catch (err) { /* offline: tenta de novo no próximo ciclo */ }
    }
    // e joga fora vídeos/imagens que saíram do conteúdo (senão a memória só cresce).
    // inclui vídeos do Cloudinary (res.cloudinary.com) além das pastas do próprio site.
    const manter = new Set(d.urls.map((u) => new URL(u, self.location.href).href));
    const ehMidiaGerenciada = (u) => /\/(anuncios|comunicados)\//.test(u) || /res\.cloudinary\.com\//.test(u);
    for (const req of await c.keys()) {
      if (ehMidiaGerenciada(req.url) && !manter.has(req.url)) await c.delete(req);
    }
  })());
});

self.addEventListener('install', (e) => {
  // busca o app ignorando o cache do navegador (GitHub manda guardar por 10 min)
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) await c.put(u, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // mídia de fora (vídeos no Cloudinary) precisa ser guardada para rodar offline;
  // já clima/câmbio (respostas de dados) seguem sempre direto pra rede.
  const ehMidia = e.request.destination === 'video' || e.request.destination === 'image';
  if (url.origin !== location.origin && !ehMidia) return;

  // só o que é do player passa por aqui. A landing (raiz), o admin e o síndico
  // vão direto pra rede — não podem ser servidos do cache do player.
  const doPlayer = ehMidia
    || url.pathname.startsWith('/tela/')
    || url.pathname === '/config.json'
    || ehArquivoDeNoticias(url.pathname)
    || url.pathname === '/manifest.json'
    || /^\/(anuncios|comunicados)\//.test(url.pathname);
  if (!doPlayer) return;

  // a checagem de versão do player precisa ver a rede, nunca a cópia guardada
  if (url.searchParams.has('versao')) { e.respondWith(fetch(e.request)); return; }

  // a página em si (o app): tenta rede primeiro para pegar novidades de visual,
  // e se estiver offline usa a cópia salva. Assim as atualizações aparecem na hora.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const salvo = () => caches.match('/tela/index.html').then((c) => c || caches.match('/tela/'));
      const resposta = (corpo) => new Response(corpo, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

      // Lê a resposta INTEIRA (cabeçalho + corpo) antes de considerar que a rede
      // respondeu. Corrigido em 04/09: o prazo de 4s cobria só o começo da
      // resposta (o cabeçalho). Numa Wi-Fi que cai no meio, o cabeçalho chegava
      // rápido, a corrida terminava "com sucesso", e o corpo do HTML ficava
      // pendurado pra sempre — a página velha já tinha morrido (relógio parado),
      // a nova nunca chegava, e a tela ficava congelada no meio da recarga sem
      // erro (Auto Reload after Page Error não dispara) e sem processo travado
      // (Restart on Unresponsiveness não dispara). Nada socorria.
      const rede = (async () => {
        const r = await fetch(e.request.url, { cache: 'no-store' });
        if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
        return await r.text();
      })();

      // grava SEMPRE o resultado da rede — mesmo que o prazo já tenha servido a
      // cópia salva. Assim, numa rede lenta a próxima abertura já pega a versão nova.
      e.waitUntil(rede.then((corpo) => caches.open(CACHE).then((c) => c.put('/tela/index.html', resposta(corpo)))).catch(() => {}));

      try {
        // Wi-Fi "conectado mas sem internet" (caso do elevador) trava a busca:
        // depois de 4s desiste e abre da memória. A tela nunca fica esperando.
        const corpo = await Promise.race([
          rede,
          new Promise((_, rej) => setTimeout(() => rej(new Error('rede lenta')), 4000))
        ]);
        return resposta(corpo);
      } catch (err) {
        // sem cópia salva (primeira abertura de todas, sem internet): não tem o
        // que fazer além de esperar a rede
        return (await salvo()) || rede.then(resposta);
      }
    })());
    return;
  }

  // dados (config/notícias): tenta rede, senão usa a cópia salva
  if (url.pathname.endsWith('config.json') || ehArquivoDeNoticias(url.pathname)) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname, cp));
        return r;
      }).catch(() => caches.match(url.pathname))
    );
    return;
  }

  // vídeos costumam vir em pedaços (Range/206); não dá para guardar pedaço no cache.
  // Se já houver a cópia completa salva, serve ela; senão vai direto pra rede.
  if (e.request.headers.has('range')) {
    e.respondWith(caches.match(e.request.url, { ignoreSearch: true }).then((c) => c || fetch(e.request)));
    return;
  }

  // aplicativo (html, imagens, vídeo completo): usa a cópia salva, atualiza por trás
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((salvo) => {
      const rede = fetch(e.request).then((r) => {
        // 'basic' = do próprio site; 'cors' = mídia do Cloudinary (permite guardar offline)
        if (r.status === 200 && (r.type === 'basic' || r.type === 'cors')) {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp));
        }
        return r;
      }).catch(() => salvo);
      return salvo || rede;
    })
  );
});
