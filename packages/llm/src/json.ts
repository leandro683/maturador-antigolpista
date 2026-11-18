import { LlmError } from './types';

export const JSON_INSTRUCTION =
  'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem comentários.';

/** Junta a instrução de JSON ao system prompt. */
export function withJsonInstruction(system: string | undefined): string {
  return system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

/** Extrai o 1º objeto JSON da resposta (aceita bloco ```json e texto em volta). */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  let s = fenced ? fenced[1]! : text;
  const i = s.indexOf('{');
  const k = s.lastIndexOf('}');
  if (i >= 0 && k > i) s = s.slice(i, k + 1);
  try {
    return JSON.parse(s);
  } catch {
    throw new LlmError('json-invalido', `resposta do modelo não é JSON válido: ${text.slice(0, 120)}`);
  }
}
