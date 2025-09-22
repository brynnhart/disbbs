'use strict';

const ALLOWED_COLORS = ['red','green','yellow','blue','magenta','cyan','white'];
const COLOR_TAGS = ['dim', ...ALLOWED_COLORS];

const EMOJI_DEFINITIONS = {
  happy: {
    src: '/static/emoji/happy.svg',
    label: 'Happy face',
  },
  sad: {
    src: '/static/emoji/sad.svg',
    label: 'Sad face',
  },
  angry: {
    src: '/static/emoji/angry.svg',
    label: 'Angry face',
  },
  shrug: {
    src: '/static/emoji/shrug.svg',
    label: 'Shrugging',
  },
  wow: {
    src: '/static/emoji/wow.svg',
    label: 'Wow face',
  },
};

const EMOJI_PATTERN = /:([a-z0-9_+-]{2,32})(?::)?/gi;

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
    const re = new RegExp(`\\[${c}\\]([\\s\\S]*?)\\[\/${c}\\]`, 'gi');
    return acc.replace(re, `<span class="${c}">$1</span>`);
  }, s);
}

function renderEmojis(html){
  if (!html) return '';
  return String(html).replace(EMOJI_PATTERN, (match, name, offset, source) => {
    const key = name.toLowerCase();
    const def = EMOJI_DEFINITIONS[key];
    if (!def) return match;

    const prev = offset > 0 ? source[offset - 1] : '';
    if (prev && /[A-Za-z0-9_]/.test(prev)) return match;

    const nextIndex = offset + match.length;
    const next = nextIndex < source.length ? source[nextIndex] : '';
    if (next && /[A-Za-z0-9_]/.test(next)) return match;

    const alt = def.alt || `:${key}:`;
    const title = def.title || def.label || alt;
    const src = def.src;

    return `<img class="emoji" src="${escapeHTML(src)}" alt="${escapeHTML(alt)}" title="${escapeHTML(title)}">`;
  });
}

function sanitizeAndFormatDIS(text){
  let out = escapeHTML(text);
  out = disUnderline(out);
  out = disBold(out);
  out = disItalics(out);
  out = disDim(out);
  out = disColors(out);
  out = renderEmojis(out);
  return out;
}

function stripDISFormatting(s){
  if (!s) return '';
  let out = String(s);
  COLOR_TAGS.forEach(tag => {
    const open  = new RegExp(`\\[${tag}\\]`, 'gi');
    const close = new RegExp(`\\[\/${tag}\\]`, 'gi');
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
  EMOJI_DEFINITIONS,
  escapeHTML,
  sanitizeAndFormatDIS,
  renderEmojis,
  stripDISFormatting,
  visibleLengthDIS,
};
