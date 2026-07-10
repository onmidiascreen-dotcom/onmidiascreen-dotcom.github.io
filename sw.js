// Service Worker: grava o player na memória da tela.
// A tela liga e abre o player mesmo sem internet; a rede só serve para atualizar.
const CACHE = 'onscreen-v7';
const SHELL = ['./', 'index.html', 'manifest.json'];

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
      if (!existe) await c.add(u).catch(() => {});
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

  // a checagem de versão do player precisa ver a rede, nunca a cópia guardada
  if (url.searchParams.has('versao')) { e.respondWith(fetch(e.request)); return; }

  // a página em si (o app): tenta rede primeiro para pegar novidades de visual,
  // e se estiver offline usa a cópia salva. Assim as atualizações aparecem na hora.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const salvo = () => caches.match('index.html').then((c) => c || caches.match('./'));

      // uma única busca, sem passar pelo cache do navegador. Ela SEMPRE grava o
      // resultado — mesmo que o timeout já tenha servido a cópia salva. Assim,
      // numa rede lenta a proxima abertura ja pega a versao nova.
      const rede = fetch(e.request.url, { cache: 'no-store' }).then((r) => {
        if (r && r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put('index.html', cp));
        }
        return r;
      });

      try {
        // Wi-Fi "conectado mas sem internet" (caso do elevador) trava a busca:
        // depois de 4s desiste e abre da memória. A tela nunca fica esperando.
        return await Promise.race([
          rede,
          new Promise((_, rej) => setTimeout(() => rej(new Error('rede lenta')), 4000))
        ]);
      } catch (err) {
        e.waitUntil(rede.catch(() => {})); // deixa a busca terminar e atualizar o cache
        return (await salvo()) || rede;
      }
    })());
    return;
  }

  // dados (config/notícias): tenta rede, senão usa a cópia salva
  if (url.pathname.endsWith('config.json') || url.pathname.endsWith('noticias.json')) {
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
