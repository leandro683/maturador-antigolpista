import * as svc from '@mag/module-blacklist/service';
import { PageHeader } from '@/components/ui/page-header';
import { requireAdmin } from '@/lib/auth';
import { serverDb } from '@/server/db';
import { BlacklistWithConfirm as BlacklistManager } from './_confirm';
import * as actions from './actions';

export const metadata = { title: 'Números bloqueados' };
export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;

export default async function BloqueadosPage({ searchParams }: { searchParams: SP }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = one(sp.aba) === 'admin' ? 'admin' : 'bloqueados';
  const listId = UUID.test(one(sp.lista)) ? one(sp.lista) : null;
  const q = one(sp.q);
  const page = Math.max(1, Number(one(sp.pagina)) || 1);
  const db = serverDb();
  const [lists, nums, admins] = await Promise.all([
    svc.listLists(db),
    tab === 'bloqueados'
      ? svc.listNumbers(db, { blacklistId: listId ?? undefined, search: q, page, pageSize: PAGE_SIZE })
      : Promise.resolve({ rows: [], total: 0 }),
    tab === 'admin' ? svc.listAdminNumbers(db) : Promise.resolve([]),
  ]);

  return (
    <section>
      <PageHeader
        title="Números bloqueados"
        description="Quem estiver numa lista ativa é removido ao entrar num grupo monitorado, quando a proteção anti-golpista da operação está ligada."
      />
      <BlacklistManager
        tab={tab}
        lists={lists.map((l) => ({ id: l.id, name: l.name, count: l.count, disabled: l.disabled }))}
        listId={listId}
        numbers={nums.rows.map((n) => ({
          id: n.id,
          number: n.number,
          lid: n.lid,
          name: n.name,
          source: n.source,
          createdAt: n.createdAt.toISOString(),
        }))}
        total={nums.total}
        page={page}
        pageSize={PAGE_SIZE}
        q={q}
        admins={admins.map((a) => ({ id: a.id, number: a.number, label: a.label }))}
        actions={{
          createList: actions.createList,
          toggleList: actions.toggleList,
          deleteList: actions.deleteList,
          addNumber: actions.addNumber,
          importCsv: actions.importCsv,
          removeNumbers: actions.removeNumbers,
          addAdmin: actions.addAdmin,
          removeAdmin: actions.removeAdmin,
        }}
      />
    </section>
  );
}
