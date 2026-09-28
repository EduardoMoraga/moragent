import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, formatInline } from '../src/tui/markdown.js';
import { plain, c } from '../src/core/log.js';

test('formatInline transforms bold, italic, code, and links', () => {
  const customColors = {
    bold: (s) => `[B]${s}[/B]`,
    italic: (s) => `[I]${s}[/I]`,
    cyan: (s) => `[C]${s}[/C]`,
  };

  const bold = formatInline('Esto es **negrita** y __otra__', customColors);
  assert.ok(bold.includes('[B]negrita[/B]'));
  assert.ok(bold.includes('[B]otra[/B]'));

  const italic = formatInline('Esto es *itálica* y _otra_', customColors);
  assert.ok(italic.includes('[I]itálica[/I]'));
  assert.ok(italic.includes('[I]otra[/I]'));

  const code = formatInline('Usa `const x = 1;` aquí', customColors);
  assert.ok(code.includes('[C]const[/C] [C]x[/C] [C]=[/C] [C]1;[/C]'));

  const link = formatInline('Visita [Moragent](https://github.com/moragent) ahora', customColors);
  assert.equal(link, 'Visita Moragent (https://github.com/moragent) ahora');
});

test('renderMarkdown headings are bold and prefixed', () => {
  const text = '# Título Principal\n## Subtítulo Secundario\n### Sección Tres';
  const lines = renderMarkdown(text, 80);

  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => plain(l).length <= 80));
  assert.ok(plain(lines[0]).startsWith('# Título Principal'));
  assert.ok(plain(lines[1]).startsWith('## Subtítulo Secundario'));
  assert.ok(plain(lines[2]).startsWith('### Sección Tres'));
});

test('renderMarkdown bullet lists have • and hanging indent on wrapping', () => {
  const text = '- Este es un elemento de lista con bastante texto para asegurar que se divida en múltiples renglones en la terminal.';
  const lines = renderMarkdown(text, 40);

  assert.ok(lines.length > 1);
  assert.ok(plain(lines[0]).startsWith('• '));
  // Hanging indent: subsequent lines should start with 2 spaces
  for (let i = 1; i < lines.length; i++) {
    assert.ok(plain(lines[i]).startsWith('  '));
    assert.ok(!plain(lines[i]).startsWith('• '));
  }
  assert.ok(lines.every((l) => plain(l).length <= 40));
});

test('renderMarkdown numbered lists have number prefix and hanging indent', () => {
  const text = '1. Primer paso del procedimiento que contiene una explicación detallada que sobrepasa el ancho límite de la pantalla.';
  const lines = renderMarkdown(text, 45);

  assert.ok(lines.length > 1);
  assert.ok(plain(lines[0]).startsWith('1. '));
  // Hanging indent: subsequent lines should start with 3 spaces matching '1. '
  for (let i = 1; i < lines.length; i++) {
    assert.ok(plain(lines[i]).startsWith('   '));
    assert.ok(!plain(lines[i]).startsWith('1. '));
  }
  assert.ok(lines.every((l) => plain(l).length <= 45));
});

test('renderMarkdown blockquotes prefix lines with vertical bar │', () => {
  const text = '> La simplicidad es un prerrequisito para la confiabilidad. Esta cita debe envolverse adecuadamente.';
  const lines = renderMarkdown(text, 40);

  assert.ok(lines.length > 1);
  for (const l of lines) {
    assert.ok(plain(l).startsWith('│ '));
    assert.ok(plain(l).length <= 40);
  }
});

test('renderMarkdown fenced code blocks are dimmed, not reflowed, and hard-wrapped', () => {
  const code = '```javascript\nfunction test() {\n  const superLongIdentifierThatCannotBeReflowedOrBrokenIntoWords = 123456789;\n}\n```';
  const lines = renderMarkdown(code, 30);

  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => plain(l).length <= 30));
  // Code lines should be dimmed
  assert.ok(lines.some((l) => plain(l).includes('function test() {')));
  assert.ok(lines.some((l) => plain(l).includes('superLongId')));
});

test('renderMarkdown tables align when fitting width', () => {
  const md = `
| Comando | Descripción | Estado |
| :--- | :--- | :--- |
| /ayuda | Muestra ayuda | Activo |
| /sesion | Lista sesiones | Listo |
`.trim();

  const lines = renderMarkdown(md, 80);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => plain(l).length <= 80));

  const plainLines = lines.map(plain);
  assert.ok(plainLines[0].includes('Comando') && plainLines[0].includes('│') && plainLines[0].includes('Estado'));
  assert.ok(plainLines[1].includes('─┼─'));
  assert.ok(plainLines[2].includes('/ayuda') && plainLines[2].includes('Activo'));
});

test('renderMarkdown tables degrade gracefully to bullet rows when exceeding width', () => {
  const md = `
| Clave | Descripción Extremadamente Larga Que No Cabe | Valor |
| --- | --- | --- |
| timeout | Tiempo de espera antes de abortar operación | 5000ms |
`.trim();

  const lines = renderMarkdown(md, 30);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => plain(l).length <= 30));
  const text = plain(lines.join('\n'));
  assert.ok(text.includes('• Clave: timeout'));
  assert.ok(text.includes('Valor: 5000ms'));
});

test('renderMarkdown handles Spanish text with accents and tildes correctly', () => {
  const spanish = 'En un lugar de la Mancha, de cuyo nombre no quiero acordarme: ¿cuál es el pingüino más rápido del camión? ¡Excelente solución!';
  for (const width of [20, 60, 120]) {
    const lines = renderMarkdown(spanish, width);
    assert.ok(lines.length > 0);
    for (const l of lines) {
      assert.ok(plain(l).length <= width, `Line "${plain(l)}" exceeds width ${width}`);
    }
    const joined = plain(lines.join(' '));
    assert.ok(joined.includes('Mancha'));
    assert.ok(joined.includes('pingüino'));
    assert.ok(joined.includes('camión'));
    assert.ok(joined.includes('¿cuál'));
    assert.ok(joined.includes('¡Excelente'));
  }
});

test('renderMarkdown never throws on malformed markdown', () => {
  const malformedSamples = [
    null,
    undefined,
    '',
    '   \n\n   ',
    '**negrita sin cerrar',
    '*itálica sin cerrar',
    '`código sin cerrar',
    '[enlace incompleto](https://',
    '[enlace sin cerrar',
    '```python\ncódigo sin cierre de bloque',
    '| tabla incompleta |',
    '| a | b |\n| --- |\n| c | d | e |',
    'PalabraSuperLargaSinEspaciosQueExcedeCualquierAnchoConfiguradoParaVerificarElCorteDuro1234567890',
  ];

  for (const sample of malformedSamples) {
    for (const width of [20, 60, 120]) {
      assert.doesNotThrow(() => {
        const lines = renderMarkdown(sample, width);
        assert.ok(Array.isArray(lines));
        assert.ok(lines.every((l) => plain(l).length <= width));
      });
    }
  }
});

test('renderMarkdown respects width bounds strictly at 20, 60, and 120', () => {
  const doc = `
# Encabezado Nivel 1

Este es un párrafo completo con **texto en negrita**, *texto en cursiva*, y un [enlace útil](https://example.org).
También incluye \`código en línea\` dentro de la narrativa.

- Primer elemento de lista con detalles adicionales sobre el procedimiento.
- Segundo elemento con sub-detalles que requieren varias líneas para envolverse.

1. Paso secuencial inicial.
2. Paso secuencial secundario con explicación más extendida.

> Esta es una nota importante dentro de un bloque de cita que debe conservar la barra vertical.

\`\`\`json
{
  "clave": "valor_muy_largo_que_ocupa_bastante_espacio_horizontal_en_el_bloque_de_codigo",
  "numero": 42
}
\`\`\`

| Propiedad | Tipo | Por Defecto |
| :--- | :--- | :--- |
| ancho | number | 80 |
| colores | object | c |
`.trim();

  for (const width of [20, 60, 120]) {
    const lines = renderMarkdown(doc, width, { c });
    assert.ok(lines.length > 0);
    for (let idx = 0; idx < lines.length; idx++) {
      const lineLen = plain(lines[idx]).length;
      assert.ok(
        lineLen <= width,
        `Line ${idx} at width ${width} has length ${lineLen}: "${plain(lines[idx])}"`
      );
    }
  }
});
