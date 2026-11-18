'use server';

import { checkPublicNumber, type PublicVerifyResult } from '@/server/services/public-verify';

export async function publicVerifyAction(slug: string, query: string): Promise<PublicVerifyResult> {
  return checkPublicNumber(slug, query);
}
