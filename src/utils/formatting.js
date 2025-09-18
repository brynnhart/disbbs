'use strict';

const ALLOWED_COLORS = ['red','green','yellow','blue','magenta','cyan','white'];
const COLOR_TAGS = ['dim', ...ALLOWED_COLORS];

function escapeHTML(s){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function disUnderline(s){
  return s.replace(/__([^_]+)__/g,'<span class="u">$1</span>');
}

function disBold(s){
  return s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}

function disItalics(s){
  return s.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g,'$1<em>$2</em>');
}

function disDim(s){
  return s.replace(/\[dim\]([\s\S]*?)\[\/dim\]/gi,'<span class="dim">$1</span>');
}

function disColors(s){
  return ALLOWED_COLORS.reduce((acc, c) => {
    const re = new RegExp(`\\\\[${c}\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/${c}\\\\]`, 'gi');
    return acc.replace(re, `<span class="${c}">$1</span>`);
  }, s);
}

function sanitizeAndFormatDIS(text){
  let out = escapeHTML(text);
  out = disUnderline(out);
  out = disBold(out);
  out = disItalics(out);
  out = disDim(out);
  out = disColors(out);
  return out;
}

function stripDISFormatting(s){
  if (!s) return '';
  let out = String(s);
  COLOR_TAGS.forEach(tag => {
    const open  = new RegExp(`\\\\[${tag}\\\\]`, 'gi');
    const close = new RegExp(`\\\\[\\\\/${tag}\\\\]`, 'gi');
    out = out.replace(open, '').replace(close, '');
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(^|[^_])_([^_\n][^_]*?)_(?!_)/g, '$1$2');
  out = out.replace(/\[(?:\/)?[a-z]+\]/gi, '');
  return out;
}

function visibleLengthDIS(s){
  return stripDISFormatting(String(s)).length;
}

module.exports = {
  ALLOWED_COLORS,
  COLOR_TAGS,
  escapeHTML,
  sanitizeAndFormatDIS,
  stripDISFormatting,
  visibleLengthDIS,
};
