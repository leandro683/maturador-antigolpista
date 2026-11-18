import 'server-only';
import { headers } from 'next/headers';
import {
  createPublicLimiter,
  publicVerify,
  publicVerifyPage,
  type PublicVerifyStatus,
} from '@mag/module-security';
import { trustedClientIp } from '../client-ip';
import { serverDb } from '../db';

/** /verificar/<slug> sem login — só o veredito, com limite por IP e por página. */

const allow = createPublicLimiter();

export const loadPublicVerifyPage = (slug: string) => publicVerifyPage(serverDb(), slug.toLowerCase());

export type PublicVerifyResult = { status: PublicVerifyStatus | 'limite' | 'indisponivel' };

export async function checkPublicNumber(slug: string, query: string): Promise<PublicVerifyResult> {
  const s = String(slug).toLowerCase().slice(0, 32);
  const ip = trustedClientIp(await headers());
  if (!allow(ip, s)) return { status: 'limite' };
  const r = await publicVerify(serverDb(), s, String(query ?? '').slice(0, 60));
  return r ?? { status: 'indisponivel' };
}
