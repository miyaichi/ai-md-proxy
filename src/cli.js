#!/usr/bin/env node
// 使い方:
//   node src/cli.js <URL> [--slots N] [--stats]
//   node src/cli.js --file page.html --base https://example.com/ [--slots N] [--stats]
import fs from 'node:fs';
import { urlToMarkdown, htmlToMarkdown } from './extract.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const slots = Number(opt('--slots') || 0);
const file = opt('--file');
const url = args.find((a) => /^https?:\/\//.test(a) && a !== opt('--base'));

try {
  const result = file
    ? htmlToMarkdown(fs.readFileSync(file, 'utf8'), opt('--base') || 'https://example.com/', { adSlots: slots })
    : await urlToMarkdown(url, { adSlots: slots });
  process.stdout.write(result.markdown);
  if (args.includes('--stats')) console.error('\n[stats]', JSON.stringify(result.meta.adStats));
} catch (e) {
  console.error('エラー:', e.message);
  if (!url && !file) console.error('使い方: node src/cli.js <URL> | --file page.html --base <URL>');
  process.exit(1);
}
