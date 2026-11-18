import { pgSchema } from 'drizzle-orm/pg-core';

/** Todas as tabelas e enums vivem no schema `mag`. */
export const MAG_SCHEMA = 'mag';
/** Nome mantido por compatibilidade com o código portado (`mag.table(...)` nas tabelas dos módulos). */
export const mag = pgSchema(MAG_SCHEMA);
