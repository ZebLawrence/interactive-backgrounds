// A stray backtick inside a GLSL comment ends the JavaScript template literal that holds the
// shader. The page then fails with "Unexpected identifier" and no file name, and `node --check` is
// perfectly happy, because what is left is still valid JavaScript (guidelines section 4). It cost
// an hour the first time, so it is a test.
//
// Every shader string in this project is marked `/* glsl */` before its opening backtick. This
// walks each module, finds those strings, and asserts that nothing inside one contains a backtick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'html', 'js');

/** Walks a `/* glsl *\/` template literal from its opening backtick and returns the index of the
 * backtick JavaScript will treat as the end of it. A nested `${...}` may hold a template literal of
 * its own, so brace depth is tracked and only a backtick at depth 0 ends the string. */
function endOfTemplate(source, open) {
  let depth = 0;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && source[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}' && depth > 0) { depth--; continue; }
    if (c === '`') {
      if (depth === 0) return i;
      let j = i + 1;
      while (j < source.length && source[j] !== '`') { if (source[j] === '\\') j++; j++; }
      i = j;
    }
  }
  return source.length;
}

/**
 * Reports every GLSL string whose terminating backtick sits inside a comment. That is the whole
 * failure mode: a backtick written inside a GLSL comment ends the literal there, leaving the rest
 * of the shader to be parsed as JavaScript. Looking for "the string ends in a comment" catches it,
 * where simply looking for backticks cannot (by then the string has already ended).
 */
export function glslTerminatedInComment(source) {
  const bad = [];
  const marker = '/* glsl */';
  let at = 0;
  while (true) {
    const m = source.indexOf(marker, at);
    if (m < 0) break;
    const open = source.indexOf('`', m + marker.length);
    if (open < 0) break;
    const end = endOfTemplate(source, open);
    const body = source.slice(open + 1, end);
    // Comment state at the end of the body, scanning the GLSL as GLSL.
    let line = false, block = false;
    for (let i = 0; i < body.length; i++) {
      if (line) { if (body[i] === '\n') line = false; continue; }
      if (block) { if (body[i] === '*' && body[i + 1] === '/') { block = false; i++; } continue; }
      if (body[i] === '/' && body[i + 1] === '/') { line = true; i++; }
      else if (body[i] === '/' && body[i + 1] === '*') { block = true; i++; }
    }
    if (line || block) {
      const lineNo = source.slice(0, end).split('\n').length;
      const text = source.slice(0, end).split('\n').pop().trim();
      bad.push({ line: lineNo, text });
    }
    at = end + 1;
  }
  return bad;
}

test('no GLSL string ends inside a comment', () => {
  const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 3, 'expected the js folder to have modules in it');
  const problems = [];
  for (const f of files) {
    const src = readFileSync(path.join(JS_DIR, f), 'utf8');
    for (const b of glslTerminatedInComment(src)) problems.push(`${f}:${b.line}  ${b.text}`);
  }
  assert.deepEqual(problems, [], `a backtick in a GLSL comment cut the shader short:\n${problems.join('\n')}`);
});

test('the check finds a planted backtick and ignores a nested template', () => {
  const planted = 'const S = /* glsl */ `\n// takes `p` and returns it\nvoid main() {}\n`;';
  assert.equal(glslTerminatedInComment(planted).length, 1);
  const nested = 'const S = /* glsl */ `\nfloat x;\n${inner}\n// fine\nvoid main() {}\n`;';
  assert.equal(glslTerminatedInComment(nested).length, 0);
  const blockComment = 'const S = /* glsl */ `\n/* takes `p` */\nvoid main() {}\n`;';
  assert.equal(glslTerminatedInComment(blockComment).length, 1);
});

test('every GLSL reserved word is avoided as a variable name', () => {
  // out, in, inout, input, output, filter and sample are reserved in GLSL ES 3.0; naming a variable
  // `out` breaks every shader that includes the helper (guidelines section 4).
  const reserved = ['out', 'in', 'inout', 'input', 'output', 'filter', 'sample'];
  const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const problems = [];
  for (const f of files) {
    const src = readFileSync(path.join(JS_DIR, f), 'utf8');
    const marker = '/* glsl */';
    let at = 0;
    while (true) {
      const m = src.indexOf(marker, at);
      if (m < 0) break;
      const open = src.indexOf('`', m + marker.length);
      if (open < 0) break;
      let i = open + 1, depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
        if (c === '}' && depth > 0) { depth--; continue; }
        if (c === '`' && depth === 0) break;
      }
      const body = src.slice(open + 1, i);
      for (const w of reserved) {
        const re = new RegExp(`\\b(?:float|vec2|vec3|vec4|int|bool|mat2|mat3|mat4)\\s+${w}\\b`);
        if (re.test(body)) problems.push(`${f}: declares a variable named "${w}"`);
      }
      at = i + 1;
    }
  }
  assert.deepEqual(problems, []);
});
