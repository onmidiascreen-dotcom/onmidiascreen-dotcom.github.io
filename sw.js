// Service Worker: grava o player na memória da tela.
// A tela liga e abre o player mesmo sem internet; a rede só serve para atualizar.
const CACHE = 'onscreen-v5';
const SHELL = ['./', 'index.html', 'manifest.json'];

// o player pede para guardar vídeos/imagens na memória enquanto tem internet,
// para que rodem mesmo depois que a internet cair
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.tipo !== 'guardar' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all(d.urls.map((u) =>
      c.match(u, { ignoreSearch: true }).then((existe) => existe || c.add(u).catch(() => {}))
    ))
  ));
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
    e.respondWith(
      fetch(e.request).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put('index.html', cp));
        return r;
      }).catch(() => caches.match('index.html').then((c) => c || caches.match('./')))
    );
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
