import { normalizeEntry } from './normalize';

/** Importação CSV de números bloqueados: colunas `telefone` e/ou `lid` (+ `nome` opcional). */

export type CsvEntry = { number?: string; lid?: string; name?: string };
export type CsvError = { line: number; value: string; reason: string };
export type CsvResult = { entries: CsvEntry[]; errors: CsvError[]; duplicates: number };

const PHONE_COLS = ['telefone', 'phone', 'numero', 'número', 'number', 'celular', 'whatsapp'];
const LID_COLS = ['lid'];
const NAME_COLS = ['nome', 'name'];

/** Split de 1 linha CSV com aspas (`""` = aspa literal). */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectSep(header: string): string {
  const counts = [';', ',', '\t'].map((s) => [s, splitCsvLine(header, s).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

const norm = (s: string) => s.trim().toLowerCase();

export function parseBlockCsv(text: string): CsvResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const res: CsvResult = { entries: [], errors: [], duplicates: 0 };
  if (first < 0) return res;

  const sep = detectSep(lines[first]!);
  const head = splitCsvLine(lines[first]!, sep).map(norm);
  const idx = (names: string[]) => head.findIndex((h) => names.includes(h));
  let phoneI = idx(PHONE_COLS);
  const lidI = idx(LID_COLS);
  const nameI = idx(NAME_COLS);
  const hasHeader =
    phoneI >= 0 || lidI >= 0 || nameI >= 0 || head.some((h) => /[a-z]{3,}/.test(h) && !h.includes('@'));
  if (hasHeader && phoneI < 0 && lidI < 0) {
    res.errors.push({
      line: first + 1,
      value: lines[first]!,
      reason: 'coluna "telefone" ou "lid" não encontrada',
    });
    return res;
  }
  if (!hasHeader) phoneI = 0;

  const seen = new Set<string>();
  for (let i = hasHeader ? first + 1 : first; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cols = splitCsvLine(raw, sep);
    const phone = phoneI >= 0 ? (cols[phoneI] ?? '') : '';
    const lid = lidI >= 0 ? (cols[lidI] ?? '') : '';
    const name = nameI >= 0 ? cols[nameI] || undefined : undefined;
    if (!phone && !lid) continue;
    const key = phone ? normalizeEntry(phone, 'auto') : normalizeEntry(lid, 'lid');
    if (!key) {
      res.errors.push({
        line: i + 1,
        value: phone || lid,
        reason: phone ? 'número inválido' : 'LID inválido',
      });
      continue;
    }
    const k = key.number ? `n:${key.number}` : `l:${key.lid}`;
    if (seen.has(k)) {
      res.duplicates++;
      continue;
    }
    seen.add(k);
    res.entries.push({ ...(name ? { name } : {}), ...key });
  }
  return res;
}
