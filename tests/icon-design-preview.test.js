const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const previewPath = path.join(__dirname, '..', 'icon-design-preview.html');
const previewHtml = fs.readFileSync(previewPath, 'utf8');

function readSvgTextEntries(html) {
  const entries = [];
  const svgPattern = /<svg\b[^>]*>([\s\S]*?)<\/svg>/g;
  let svgMatch;

  while ((svgMatch = svgPattern.exec(html))) {
    const textPattern = /<text\b[^>]*\by="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
    let textMatch;

    while ((textMatch = textPattern.exec(svgMatch[1]))) {
      entries.push({
        text: textMatch[2].trim(),
        y: Number(textMatch[1])
      });
    }
  }

  return entries;
}

test('queue labels use ORQ and SVG text stays inside the safe baseline zone', () => {
  const entries = readSvgTextEntries(previewHtml);
  const orqLabels = entries.filter((entry) => entry.text === 'ORQ');

  assert.equal(orqLabels.length, 2);
  assert.equal(entries.some((entry) => entry.y > 134), false);
});

test('main OR marks use an impactful font and optical-center compensation', () => {
  const mainMarks = Array.from(previewHtml.matchAll(/<text\b([^>]*)data-role="main-mark"([^>]*)>OR<\/text>/g));

  assert.equal(mainMarks.length, 10);
  mainMarks.forEach((match) => {
    const attributes = `${match[1]}${match[2]}`;
    assert.match(attributes, /font-family="Arial Black, Segoe UI Black, Segoe UI, sans-serif"/);
    assert.match(attributes, /text-anchor="middle"/);
    assert.match(attributes, /dominant-baseline="middle"/);
    assert.ok(Number(attributes.match(/\bx="([\d.]+)"/)[1]) < 80);
    const y = Number(attributes.match(/\by="([\d.]+)"/)[1]);
    const layout = attributes.match(/data-layout="([^"]+)"/)[1];
    if (layout === 'upper-mark') {
      assert.ok(y >= 56 && y <= 64);
    } else {
      assert.ok(y >= 84 && y <= 88);
    }
  });
});
