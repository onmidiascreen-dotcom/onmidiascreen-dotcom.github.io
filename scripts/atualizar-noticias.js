// Roda no GitHub Actions a cada 15 min: busca o RSS do G1 e grava noticias.json
// (título + foto de cada matéria). O player só lê o arquivo estático.
const fs = require('fs');
const path = require('path');
const destino = path.join(__dirname, '..', 'noticias.json');

// fonte escolhida no config.json ("fonteNoticias": "uol" | "cnn" | "g1")
const FONTES = {
  g1: 'https://g1.globo.com/rss/g1/',
  uol: 'https://rss.uol.com.br/feed/noticias.xml',
  cnn: 'https://www.cnnbrasil.com.br/feed/',
};
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const fonte = FONTES[config.fonteNoticias] || FONTES.uol;

async function main() {
  const r = await fetch(fonte, {
    headers: { 'User-Agent': 'Mozilla/5.0 (OnScreenPlayer)' },
  });
  if (!r.ok) throw new Error('RSS respondeu ' + r.status);
  // alguns feeds (UOL) usam ISO-8859-1 em vez de UTF-8 — checa o cabeçalho e a declaração
  const buf = Buffer.from(await r.arrayBuffer());
  let xml = buf.toString('utf8');
  const tipo = (r.headers.get('content-type') || '') + ' ' + xml.slice(0, 200);
  if (/8859|latin/i.test(tipo)) xml = buf.toString('latin1');

  const noticias = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => {
      const bloco = m[1];
      const t = bloco.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const img = bloco.match(/<media:content[^>]*url="([^"]+)"/);
      return t ? { titulo: t[1].trim(), imagem: img ? img[1] : null } : null;
    })
    .filter(Boolean)
    .slice(0, 30); // guarda mais manchetes: mais variedade girando, inclusive offline

  if (!noticias.length) throw new Error('nenhuma noticia extraida');

  fs.writeFileSync(destino, JSON.stringify({
    noticias,
    atualizadoEm: new Date().toISOString(),
  }, null, 2));
  console.log(noticias.length + ' noticias gravadas');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
