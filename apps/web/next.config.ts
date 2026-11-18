import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  // imagem Docker define NEXT_OUTPUT=standalone
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  // pacotes e módulos do monorepo exportam TS fonte
  transpilePackages: [
    '@mag/db',
    '@mag/shared',
    '@mag/wa-engine',
    '@mag/llm',
    '@mag/accounts',
    '@mag/module-blacklist',
    '@mag/module-security',
    '@mag/module-warmup',
  ],
  // páginas importam ../../modules/* por caminho relativo
  experimental: { externalDir: true },
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // sharp (hash de foto do anti-impostor) é binário nativo: nunca empacotar, resolver do node_modules em runtime
  serverExternalPackages: ['bullmq', 'ioredis', 'postgres', 'sharp'],
  eslint: { ignoreDuringBuilds: true },
  typedRoutes: false,
};

export default config;
