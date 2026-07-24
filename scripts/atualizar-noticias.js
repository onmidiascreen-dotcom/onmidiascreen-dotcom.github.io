// Roda no GitHub Actions a cada 15 min: busca o RSS de CADA fonte disponível e
// grava um arquivo por fonte (noticias-g1.json, noticias-uol.json, noticias-cnn.json).
// Cada prédio pode escolher a sua (painel do dono ou do síndico); sem escolha
// própria, usa o padrão do sistema (config.json > fonteNoticias).
// noticias.json (sem sufixo) continua sendo gravado como um alias do padrão do
// sistema, para não quebrar telas com uma versão de cache anterior a isto.
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const FONTES = {
  g1: 'https://g1.globo.com/rss/g1/',
  uol: 'https://rss.uol.com.br/feed/noticias.xml',
  cnn: 'https://www.cnnbrasil.com.br/feed/',
};
const config = JSON.parse(fs.readFileSync(path.join(raiz, 'config.json'), 'utf8'));
const padrao = FONTES[config.fonteNoticias] ? config.fonteNoticias : 'uol';

async function buscarFonte(chave, url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (OnScreenPlayer)' } });
  if (!r.ok) throw new Error(chave + ' respondeu ' + r.status);
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

  if (!noticias.length) throw new Error(chave + ': nenhuma noticia extraida');
  return { noticias, atualizadoEm: new Date().toISOString() };
}

async function main() {
  const chaves = Object.keys(FONTES);
  const resultados = await Promise.allSettled(chaves.map((k) => buscarFonte(k, FONTES[k])));

  let algumaOk = false;
  resultados.forEach((res, i) => {
    const chave = chaves[i];
    const destino = path.join(raiz, 'noticias-' + chave + '.json');
    if (res.status === 'fulfilled') {
      fs.writeFileSync(destino, JSON.stringify(res.value, null, 2));
      console.log(chave + ': ' + res.value.noticias.length + ' noticias gravadas');
      algumaOk = true;
      // o padrão do sistema também grava no nome antigo (compatibilidade)
      if (chave === padrao) {
        fs.writeFileSync(path.join(raiz, 'noticias.json'), JSON.stringify(res.value, null, 2));
      }
    } else {
      // uma fonte fora do ar não derruba as outras — mantém o arquivo antigo dela como está
      console.error(chave + ': falhou (' + res.reason.message + '), mantendo o arquivo anterior');
    }
  });

  if (!algumaOk) throw new Error('todas as fontes falharam');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
