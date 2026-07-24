// Service worker mínimo só para o painel do síndico virar um "app" instalável
// no Android (o Chrome exige um SW registrado para oferecer "Adicionar à tela
// inicial"). No iPhone isso nem é necessário, mas não atrapalha.
// Este painel sempre precisa da rede (login, comunicados) — não guarda nada
// em cache, só existe para satisfazer o critério de instalação.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
