export type ModelTier = 'principal' | 'reserva' | 'pago';
export type ApprovedModel = { slug: string; name: string; tier: ModelTier; effort: 'none' | 'low'; note: string };

/** Lista fechada: o servidor só aceita estes slugs; a ordem é a ordem de tentativa. */
export const APPROVED_MODELS: readonly ApprovedModel[] = [
  { slug: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA Nemotron 3 Ultra', tier: 'principal', effort: 'none', note: 'o melhor dos testes' },
  { slug: 'nvidia/nemotron-3.5-super-vl:free', name: 'NVIDIA Nemotron 3.5 Super VL', tier: 'principal', effort: 'none', note: '10 falas exatas, fatos certos' },
  { slug: 'google/gemma-4-26b-a4b-it:free', name: 'Google Gemma 4 26B', tier: 'principal', effort: 'none', note: 'muito bom; às vezes 429 (fila compartilhada)' },
  { slug: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note (expira 31/12/2026)', tier: 'reserva', effort: 'none', note: 'inventa placares' },
  { slug: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 Lightning', tier: 'reserva', effort: 'none', note: 'erros de fato' },
  { slug: 'google/gemma-4-31b-it:free', name: 'Google Gemma 4 31B', tier: 'reserva', effort: 'none', note: '429 frequente' },
  { slug: 'mistralai/mistral-nemo', name: 'Mistral Nemo', tier: 'pago', effort: 'none', note: 'US$ 0,029 / 0,03 por milhão' },
  { slug: 'mistralai/mistral-small-24b-instruct-2501', name: 'Mistral Small 24B', tier: 'pago', effort: 'none', note: 'US$ 0,05 / 0,08 por milhão' },
  { slug: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', tier: 'pago', effort: 'low', note: 'US$ 0,15 / 0,50 por milhão; raciocínio obrigatório' },
];

export const FREE_DEFAULT: string[] = APPROVED_MODELS.filter((m) => m.tier !== 'pago').map((m) => m.slug);
export const PAID_DEFAULT: string[] = APPROVED_MODELS.filter((m) => m.tier === 'pago').map((m) => m.slug);

export const modelInfo = (slug: string): ApprovedModel | undefined => APPROVED_MODELS.find((m) => m.slug === slug);
export const isFree = (slug: string): boolean => {
  const m = modelInfo(slug);
  return !!m && m.tier !== 'pago';
};
