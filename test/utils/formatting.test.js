const test = require('node:test');
const assert = require('node:assert');

const {
  escapeHTML,
  sanitizeAndFormatDIS,
  renderEmojis,
  stripDISFormatting,
  visibleLengthDIS,
} = require('../../src/utils/formatting');

test('escapeHTML escapes special characters', () => {
  const input = `<script>const x = 1 & 2; \"quote\" 'single'</script>`;
  const expected = '&lt;script&gt;const x = 1 &amp; 2; &quot;quote&quot; &#39;single&#39;&lt;/script&gt;';
  assert.strictEqual(escapeHTML(input), expected);
});

test('sanitizeAndFormatDIS applies markup and emoji rendering', () => {
  const input = 'Hello __under__ **bold** _ital_ [dim]dim[/dim] [red]red[/red] :happy:';
  const expected =
    'Hello <span class="u">under</span> <strong>bold</strong> <em>ital</em> <span class="dim">dim</span> <span class="red">red</span> ' +
    '<img class="emoji" src="/static/emoji/happy.svg" alt=":happy:" title="Happy face">';
  assert.strictEqual(sanitizeAndFormatDIS(input), expected);
});

test('sanitizeAndFormatDIS linkifies URLs with truncated labels', () => {
  const input = 'Visit http://www.google.com/1234567890 for more info!';
  const expected =
    'Visit <a class="ext-link" href="http://www.google.com/1234567890" target="_blank" rel="noopener noreferrer">www.google.com/123456...</a> for more info!';
  assert.strictEqual(sanitizeAndFormatDIS(input), expected);
});

test('renderEmojis leaves unknown emoji codes untouched', () => {
  const input = 'Try :unknown: but keep :happy:!';
  const output = renderEmojis(input);
  assert.match(output, /:unknown:/);
  assert.match(output, /<img class="emoji" src="\/static\/emoji\/happy.svg"/);
});

test('stripDISFormatting removes tags and markup', () => {
  const input = '**bold** __underline__ [red]color[/red] plain';
  const expected = 'bold underline color plain';
  assert.strictEqual(stripDISFormatting(input), expected);
});

test('visibleLengthDIS measures printable length', () => {
  const input = 'Look **here** [green]friend[/green]!';
  assert.strictEqual(visibleLengthDIS(input), 'Look here friend!'.length);
});

test('visibleLengthDIS counts truncated link labels instead of raw URLs', () => {
  const input = 'Check this http://example.com/abcdef123456 right now';
  const html = sanitizeAndFormatDIS(input);
  const match = html.match(/<a[^>]*>([^<]+)<\/a>/);
  assert.ok(match, 'expected a linked URL in formatted HTML');
  const display = match[1];
  const expectedLength = `Check this ${display} right now`.length;
  assert.strictEqual(visibleLengthDIS(input), expectedLength);
});
