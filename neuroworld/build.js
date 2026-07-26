#!/usr/bin/env node
/*
 * build.js — inline the stylesheet and scripts into one self-contained file.
 *
 *   node build.js              -> neuroworld.html, a complete document you can
 *                                 email to someone or drop on any static host
 *   node build.js --fragment   -> the same page without the <!doctype>/<html>/
 *                                 <head>/<body> shell, for hosts that supply
 *                                 their own (claude.ai artifacts, for one)
 *
 * The modular files under js/ stay the source of truth; this only concatenates.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const named = args.filter((a) => !a.startsWith('--'))[0];
const outPath = named
  ? path.resolve(process.cwd(), named)
  : path.join(root, fragment ? 'neuroworld.fragment.html' : 'neuroworld.html');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');

/* A closing tag inside the inlined text would end the block early. Neither file
 * type can legally contain one, but check rather than trust. */
function guard(text, tag, source) {
  if (new RegExp('</\\s*' + tag, 'i').test(text)) {
    throw new Error(source + ' contains a closing </' + tag + '> and cannot be inlined');
  }
  return text;
}

html = html.replace(/[ \t]*<link rel="stylesheet" href="([^"]+)">\n?/g, (_, href) =>
  '<style>\n' + guard(read(href), 'style', href) + '</style>\n');

html = html.replace(/[ \t]*<script src="([^"]+)"><\/script>\n?/g, (_, src) =>
  '<script>\n' + guard(read(src), 'script', src) + '</script>\n');

if (fragment) {
  html = html
    .replace(/<!DOCTYPE html>\s*/i, '')
    .replace(/<\/?html[^>]*>\s*/gi, '')
    .replace(/<\/?head>\s*/gi, '')
    .replace(/<\/?body>\s*/gi, '')
    /* The shell supplies charset and viewport; the title is kept because the
     * host reads it for the tab and the gallery card. */
    .replace(/[ \t]*<meta[^>]*>\n?/gi, '')
    .trim() + '\n';
}

fs.writeFileSync(outPath, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log("wrote " + path.relative(process.cwd(), outPath) + '  (' + kb + ' KB, no external requests)');
