// Service Worker: grava o player na memória da tela.
// A tela liga e abre o player mesmo sem internet; a rede só serve para atualizar.
const CACHE = 'onscreen-v1';
const SHELL = ['./', 'index.html', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // clima/câmbio seguem direto pra rede

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

  // aplicativo (html, imagens): usa a cópia salva na hora, atualiza por trás
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((salvo) => {
      const rede = fetch(e.request).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, cp));
        return r;
      }).catch(() => salvo);
      return salvo || rede;
    })
  );
});
