// Service Worker: grava o player na memória da tela.
// A tela liga e abre o player mesmo sem internet; a rede só serve para atualizar.
const CACHE = 'onscreen-v5';
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
    // e joga fora vídeos/imagens que saíram do conteúdo (senão a memória só cresce)
    const manter = new Set(d.urls.map((u) => new URL(u, self.location.href).href));
    for (const req of await c.keys()) {
      if (/\/(anuncios|comunicados)\//.test(req.url) && !manter.has(req.url)) await c.delete(req);
    }
  })());
});

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (url.origin !== location.origin) return; // clima/câmbio seguem direto pra rede

  // a página em si (o app): tenta rede primeiro para pegar novidades de visual,
  // e se estiver offline usa a cópia salva. Assim as atualizações aparecem na hora.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const salvo = () => caches.match('index.html').then((c) => c || caches.match('./'));
      try {
        // Wi-Fi "conectado mas sem internet" (caso do elevador) trava o fetch:
        // depois de 4s desiste e abre da memória. A tela nunca fica esperando.
        const r = await Promise.race([
          fetch(e.request),
          new Promise((_, rej) => setTimeout(() => rej(new Error('rede lenta')), 4000))
        ]);
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put('index.html', cp));
        return r;
      } catch (err) {
        return (await salvo()) || fetch(e.request);
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
        if (r.status === 200 && r.type === 'basic') {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp));
        }
        return r;
      }).catch(() => salvo);
      return salvo || rede;
    })
  );
});
