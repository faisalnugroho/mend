// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, the all-or-nothing write, three-tier line matching
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path exists in the tree as edited: a file an edit created or changed, or anything
   * on disk at that path (a file or a directory) that no edit has touched. A directory counts as
   * existing, so creating a file where one stands is `exists` instead of a crash in the write phase. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: a file as lines, its line break, and whether it ends with one. ----

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ---- Section 5: three-tier line matching. ----

const trimT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimB(a) === trimB(b);
}

/** All 0-based positions where O occurs in lines at the given tier. */
function occurrencesAt(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Occurrences at or after `from`; with eofOnly only those ending at the file's last line. */
function occurrencesFrom(O: string[], lines: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(from, 0); i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once, with all its occurrences. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrencesAt(O, lines, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** First tier with an occurrence at or after `from`; the earliest such occurrence. */
function findTierFrom(O: string[], lines: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrencesFrom(O, lines, t, from, eofOnly);
    if (occs.length > 0) return { tier: t, pos: occs[0]! };
  }
  return null;
}

/** First tier with an occurrence; the occurrence nearest to target (earlier on a tie). */
function findNearest(O: string[], lines: string[], target: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrencesAt(O, lines, t);
    if (occs.length > 0) {
      let best = occs[0]!;
      for (const o of occs) {
        if (Math.abs(o - target) < Math.abs(best - target)) best = o;
      }
      return { tier: t, pos: best };
    }
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines that replace O at position pos. Context lines are written as the file's own matched lines.
 * At tier 2 every other line is re-indented from O's first line's leading whitespace to the file's.
 */
function buildReplacement(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadOf(lines[pos]!);
  const P = leadOf(O[0]!);
  return N.map((e) => {
    if (e.ctx !== null) return lines[pos + e.ctx]!;
    if (tier !== 2) return e.text;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/**
 * O and N of a hunk/chunk body, plus whether a `\` line follows its last context-or-`+` line
 * (noEol) and whether one follows its last `+` line (lastPlusNoEol).
 */
function analyzeBody(body: string[]): { o: string[]; n: NLine[]; noEol: boolean; lastPlusNoEol: boolean; hasPlus: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastNIdx = -1;
  let lastPlusIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl === '' || bl[0] === ' ') {
      const t = bl === '' ? '' : bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      lastNIdx = k;
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: null });
      lastNIdx = k;
      lastPlusIdx = k;
    }
    // '\' lines refer to the body line before them and add no line of their own.
  }
  const noEol = lastNIdx >= 0 && body[lastNIdx + 1] !== undefined && body[lastNIdx + 1]!.startsWith('\\');
  const lastPlusNoEol = lastPlusIdx >= 0 && body[lastPlusIdx + 1] !== undefined && body[lastPlusIdx + 1]!.startsWith('\\');
  return { o, n, noEol, lastPlusNoEol, hasPlus: lastPlusIdx >= 0 };
}

// ---- Section 6: unified diffs. ----

interface Hunk {
  a: number;
  body: string[];
  o: string[];
  n: NLine[];
  noEol: boolean;
  lastPlusNoEol: boolean;
  hasPlus: boolean;
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.trim();
  if (rest === '/dev/null') return null;
  return rest.replace(/^[ab]\//, '');
}

/** A section's header: everything before its first hunk. Returns the index after the header. */
function parseUnifiedHeader(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(nx);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      if (sec.renOld === undefined) sec.renOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (sec.renNew === undefined) sec.renNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) {
      sec.create = true;
      i++;
      continue;
    }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
      sec.del = true;
      i++;
      continue;
    }
    // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
    i++;
  }
  return i;
}

/** A section's hunks. Returns the index of the next section's start, or the end of the patch. */
function parseUnifiedHunks(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const an = analyzeBody(body);
      sec.hunks.push({ a: parseInt(m[1]!, 10), body, o: an.o, n: an.n, noEol: an.noEol, lastPlusNoEol: an.lastPlusNoEol, hasPlus: an.hasPlus });
      i = j;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(sec);
      i = parseUnifiedHeader(lines, i + 1, sec);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { create: false, del: false, hunks: [] };
      sections.push(sec);
      i = parseUnifiedHeader(lines, i, sec);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (l.startsWith('@@')) {
      // A hunk before any section.
      if (sections.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      i++;
    } else {
      i++;
    }
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** One hunk applied to a file's lines; d is the length drift of this section's earlier hunks. */
function applyHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean, path: string): Doc {
  const { o, n, noEol } = hunk;
  if (o.length === 0) {
    const pos = Math.min(hunk.a + d, doc.lines.length);
    const rep = n.map((e) => e.text);
    const lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos)];
    const final = pos === doc.lines.length ? !noEol : doc.final;
    return { lines, br: doc.br, final };
  }
  const found = findNearest(o, doc.lines, hunk.a - 1 + d, strict);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.pos;
  const rep = buildReplacement(doc.lines, pos, o, n, found.tier);
  const lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + o.length)];
  const final = pos + o.length === doc.lines.length ? !noEol : doc.final;
  return { lines, br: doc.br, final };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let doc = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    doc = applyHunk(doc, h, d, strict, path);
    d += h.n.length - h.o.length;
  }
  return joinFile(doc);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld !== undefined ? sec.gitOld : null;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew !== undefined ? sec.gitNew : null;
    if (oldP === null && newP === null) return;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.del);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const np = newP!;
      if (tree.exists(np)) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const bl of h.body) {
          if (bl.startsWith('+')) plus.push(bl.slice(1));
        }
      }
      let lastPlusNoEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        if (sec.hunks[hi]!.hasPlus) {
          lastPlusNoEol = sec.hunks[hi]!.lastPlusNoEol;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
    } else if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    } else if (isMove) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.exists(np)) throw new Fail('exists', np);
      const out = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const out = applyHunks(tree.get(p)!, sec.hunks, strict, p);
      tree.now.set(p, out);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (eq < 0) {
        if (lines[j]!.trimEnd() === '=======') eq = j;
      } else if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let k = searchLine - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = splitFile(text);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occs.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occs[0]!;
    const rep = buildReplacement(doc.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier);
    tree.now.set(path, joinFile({ lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + oldLines.length)], br: doc.br, final: doc.final }));
  };
}

// ---- Section 8: V4A patches. ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

const isV4ASectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4AUpdate(lines: string[], start: number, end: number, updateLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let j = start;
  while (j < end && lines[j] === '') j++;
  let moveTo: string | null = null;
  if (j < end && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j++;
    while (j < end && lines[j] === '') j++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let state = 0; // 0: no chunk yet, 1: in a chunk, 2: chunk ended by *** End of File
  for (; j < end; j++) {
    const l = lines[j]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      state = 1;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
      cur.eof = true;
      state = 2;
      continue;
    }
    if (blank(l)) {
      if (state === 1) cur!.body.push(l);
      continue;
    }
    if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (state === 0) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
        state = 1;
      } else if (state === 2) {
        throw new Exit2(`error: parse ${j + 1}`);
      }
      cur!.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { moveTo, chunks };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    let doc = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTierFrom([chunk.anchor], doc.lines, cursor, strict, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      const { o, n } = analyzeBody(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? doc.lines.length : cursor;
        const rep = n.map((e) => e.text);
        doc = { lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos)], br: doc.br, final: doc.final };
        cursor = pos + rep.length;
      } else {
        const found = findTierFrom(o, doc.lines, cursor, strict, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.pos;
        const rep = buildReplacement(doc.lines, pos, o, n, found.tier);
        doc = { lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + o.length)], br: doc.br, final: doc.final };
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const start = i + 1;
      let end = start;
      while (end < last && !isV4ASectionStart(lines[end]!)) end++;
      while (end > start && blank(lines[end - 1]!)) end--;
      const fileLines: string[] = [];
      for (let j = start; j < end; j++) {
        const bl = lines[j]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = end;
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const start = i + 1;
      let end = start;
      while (end < last && !isV4ASectionStart(lines[end]!)) end++;
      while (end > start && blank(lines[end - 1]!)) end--;
      for (let j = start; j < end; j++) throw new Exit2(`error: parse ${j + 1}`);
      edits.push(v4aDeleteEdit(path));
      i = end;
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const start = i + 1;
      let end = start;
      while (end < last && !isV4ASectionStart(lines[end]!)) end++;
      while (end > start && blank(lines[end - 1]!)) end--;
      const { moveTo, chunks } = parseV4AUpdate(lines, start, end, i + 1);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = end;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ---- Section 9: JSON edits (starter code, unchanged). ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Section 2 output: one row per changed path, with successful moves as R lines sorted by <new>.
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
