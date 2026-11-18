export * from './types';
export {
  WahaClient,
  WahaHttpError,
  WaNotSupportedError,
  GOWS_CAPABILITIES,
  DEFAULT_WEBHOOK_EVENTS,
  normalizeGroup,
  wahaConfigFromEnv,
  type WahaClientOptions,
  type FetchLike,
} from './waha/client';
export { mapWahaEvent, dedupKeyOf, toMs, type WahaWebhook } from './waha/mapper';
export { sessionNameFor, QrCycle, QrCycleExhaustedError, QR_MAX_ATTEMPTS } from './waha/sessions';
export {
  ChatIdResolver,
  WaNumberNotFoundError,
  withPhoneResolution,
  phoneDigitsOf,
  phoneVariantsOf,
  type ChatIdResolution,
  type ChatIdResolverOptions,
  type PhoneLidStore,
} from './waha/resolve';
