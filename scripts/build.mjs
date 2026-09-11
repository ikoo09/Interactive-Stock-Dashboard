import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const staticFiles = ['index.html','sw.js','crypto-engine.js','crypto.png','btc.webp','eth.png','SOL.png','DOGE.png','TRX.png','BNB.webp','XRP.webp'];
for (const file of staticFiles) { const src = join(root,file); if (existsSync(src)) copyFileSync(src, join(dist,file)); }
const indexPath = join(dist,'index.html');
let html = readFileSync(indexPath,'utf8');
const tag = '<script src="/crypto-engine.js" defer></script>';
if (!html.includes(tag)) html = html.replace('</head>', `    ${tag}\n</head>`);
writeFileSync(indexPath, html, 'utf8');
console.log('CryptoScan Pro build: UI preserved; live engine injected.');