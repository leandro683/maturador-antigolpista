# Instalação passo a passo

Este guia é para quem vai instalar o sistema num computador ou servidor que só tem Docker. Os comandos rodam num terminal. No Windows, use o Git Bash ou o PowerShell. Todos os comandos partem da pasta do projeto.

O Docker Compose sobe seis serviços:

| Serviço | Para que serve |
|---|---|
| `waha` | O WAHA, que fala com o WhatsApp (motor GOWS). |
| `redis` | As filas de trabalho. |
| `postgres` | O banco de dados. |
| `migrate` | Cria e atualiza as tabelas e termina. Roda antes do `web` e do `worker`. |
| `web` | O painel, na porta 3100. Também recebe os avisos do WAHA. |
| `worker` | Processa os avisos do WhatsApp, o Maturador e a análise do Anti-golpista. |

Nenhum serviço, além do painel, publica porta. O `postgres` e o `redis` ficam numa rede interna, sem saída para a internet, e o `waha` não enxerga nenhum dos dois. O painel (`web`) e o worker falam com o `waha` por outra rede interna. Para depurar o WAHA no seu computador, suba também o arquivo `infra/docker-compose.waha-debug.yml`, que publica a API dele em `127.0.0.1:3001` (porta `WAHA_PORT`):

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.waha-debug.yml up -d
```

Se algum passo falhar, veja os registros:

```bash
docker compose --env-file .env -f infra/docker-compose.yml logs --tail 100
```

Para ver um serviço só, acrescente o nome no fim, por exemplo `logs web`.

## 1. Criar o arquivo `.env`

Copie o modelo:

```bash
cp .env.example .env
```

Gere os segredos. Rode o comando quatro vezes, um resultado para cada variável que precisa de segredo:

```bash
docker run --rm node:22-slim node -p "require('crypto').randomBytes(32).toString('hex')"
```

Abra o `.env` e preencha, no mínimo:

| Variável | O que colocar |
|---|---|
| `POSTGRES_PASSWORD` | Um segredo gerado. Use só letras e números. A senha não pode ter `@ : / ? #`. |
| `WAHA_API_KEY` | Um segredo gerado. É a chave de API do WAHA. |
| `WAHA_HOOK_HMAC_KEY` | Um segredo gerado. Assina os avisos que o WAHA envia ao painel. |
| `SESSION_SECRET` | Um segredo gerado, de pelo menos 32 caracteres. |
| `ADMIN_EMAIL` | O seu e-mail de administrador. |
| `ADMIN_PASSWORD` | Uma senha sua, de pelo menos 10 caracteres. |

As demais variáveis estão explicadas no [README](../README.md#variáveis-de-ambiente) e nos comentários do próprio `.env.example`.

Nunca envie o `.env` para ninguém nem para o GitHub.

Com o Docker Compose, `DATABASE_URL`, `REDIS_URL` e `WAHA_URL` não vêm do `.env`. O arquivo do Compose monta esses três endereços com os nomes dos serviços (`postgres`, `redis` e `waha`). Os valores do `.env` para essas variáveis só valem para quem roda o painel fora do Docker.

## 2. Subir os serviços

> **As imagens Docker ainda não foram montadas nem iniciadas em nenhuma máquina.** O caminho com Docker Compose foi validado só com `docker compose config`. A aplicação em si foi testada fora do Docker, com testes unitários, de banco de dados e de navegador. Quem montar as imagens primeiro, por favor relate os problemas que encontrar.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

O `--env-file .env` é obrigatório. O arquivo do Compose fica em `infra/`, e sem essa opção o Docker procura o `.env` em `infra/` e não acha os seus valores. A primeira subida baixa as imagens e monta o painel e o worker, e pode levar vários minutos.

O Compose cria três volumes, que guardam os seus dados: `postgres_data` (banco), `waha_sessions` (sessões do WhatsApp) e `redis_data` (filas). O nome real tem o prefixo `maturador-antigolpista_`. O WAHA não baixa as mídias recebidas, então o disco não enche com fotos e vídeos dos grupos. Se você já usou uma versão antiga e sobrou um volume `maturador-antigolpista_waha_media`, pode apagá-lo com `docker volume rm`.

As tabelas do banco são criadas pelo serviço `migrate`, sem nenhum comando extra. Confira que ele terminou bem:

```bash
docker compose --env-file .env -f infra/docker-compose.yml logs migrate
```

O esperado é que a última linha seja `migrations ok`. Se for um erro, o `web` e o `worker` não sobem.

Abra `http://localhost:3100` (ou a porta de `WEB_PORT`). O painel só aceita conexões da própria máquina. Para acessar de outro lugar, use um [proxy reverso](#proxy-reverso-e-https).

## 3. Webhook do WAHA

O WAHA envia ao painel tudo o que acontece no WhatsApp: mensagens, entradas e saídas de participantes, mudanças de grupo e estado das sessões. Sem esses avisos, o Anti-golpista não vê nada e o Maturador no modo **IA respondendo de verdade** não responde.

**Com o Compose deste projeto, não há nada a configurar.** O serviço `waha` já sai configurado com:

- **URL do webhook**: `http://web:3100/api/wa/events`, pela rede interna. Não é preciso expor esse caminho na internet.
- **HMAC**: assinatura `sha512`, cabeçalho `X-Webhook-Hmac`, com a chave `WAHA_HOOK_HMAC_KEY`. O painel recusa (401) todo aviso com assinatura inválida, e também todos os avisos se a chave não estiver configurada. O motivo só aparece nos registros do `web`. Um aviso sem `Content-Length` ou com mais de 2 MB recebe 413. Por isso não ponha nenhum proxy entre o WAHA e o painel: um proxy pode reenviar o aviso em pedaços, sem `Content-Length`, e todos seriam recusados.
- **Eventos**: `session.status`, `message`, `message.ack`, `message.ack.group`, `message.reaction`, `group.v2.join`, `group.v2.leave`, `group.v2.participants`, `group.v2.participants.join-request`, `group.v2.update` e `poll.vote`.
- **Reenvio**: se o painel não responde, o WAHA tenta de novo até 5 vezes, com espera crescente.

Se você usar um WAHA que não é o deste Compose, configure nele o mesmo: `WHATSAPP_HOOK_URL` com `{endereço do painel}/api/wa/events`, `WHATSAPP_HOOK_EVENTS` com a lista acima e `WHATSAPP_HOOK_HMAC_KEY` igual ao `WAHA_HOOK_HMAC_KEY` do `.env`. Defina também o motor GOWS como padrão (`WHATSAPP_DEFAULT_ENGINE=GOWS`). Nos eventos, use exatamente esses nomes. Nomes diferentes, como `message.in` ou `group.update`, não existem no WAHA.

Os nomes saem de `packages/wa-engine/src/waha/mapper.ts` e de `packages/wa-engine/src/waha/client.ts` (lista `DEFAULT_WEBHOOK_EVENTS`).

Se o WAHA recusa as conexões do painel, ou o painel recusa os avisos do WAHA, quase sempre a chave `WAHA_API_KEY` ou `WAHA_HOOK_HMAC_KEY` está diferente entre os dois lados.

## 4. Escolher o modo de login e de banco

### Modo Postgres do Docker (`AUTH_MODE=password`)

É o padrão. O banco é o `postgres` do Compose. No `.env`:

```bash
AUTH_MODE=password
ADMIN_EMAIL=alguem@example.com
ADMIN_PASSWORD=uma-senha-forte-sua
SESSION_SECRET=valor-gerado-no-passo-1
```

Troque `alguem@example.com` pelo seu e-mail. A entrada exige `ADMIN_PASSWORD` com pelo menos 10 caracteres e `SESSION_SECRET` com pelo menos 32. Se algum faltar ou for curto, a tela de entrada mostra "Configuração incompleta" com o motivo.

O login aceita 5 tentativas erradas a cada 15 minutos. Sem proxy, esse limite é um só para todo mundo: cinco erros de qualquer pessoa bloqueiam a entrada por 15 minutos. Atrás de um proxy reverso, defina `TRUST_PROXY=1` para o limite ser por visitante. Veja [Proxy reverso e HTTPS](#proxy-reverso-e-https).

A sessão dura 7 dias. Trocar `SESSION_SECRET` desconecta todo mundo. Trocar `ADMIN_PASSWORD` não encerra as sessões que já estão abertas.

### Modo Supabase

Use este modo se o login e o banco ficam no Supabase. Ele é suportado, mas foi validado menos que o modo anterior. Faça um teste completo antes de usar com números importantes.

**Passo 1. Proteja o projeto no Supabase, antes de ligar o painel.**

1. Em **Authentication**, crie os usuários administradores, com e-mail e senha, e com o e-mail já confirmado.
2. Em **Authentication**, nas configurações de entrada (**Sign In / Providers**), desligue **Allow new users to sign up**. A chave pública (anon) fica dentro do painel e o Supabase aceita cadastros por ela por padrão. Sem esse passo, qualquer pessoa cria uma conta no seu projeto.
3. Mantenha **Confirm email** ligado. Com a confirmação desligada, quem cadastra um e-mail que está em `ADMIN_EMAILS` entra como administrador. O painel só aceita usuários com o e-mail confirmado, mas essa checagem não protege um projeto que confirma tudo sozinho.
4. Não adicione o schema `mag` em **Exposed schemas** (configurações da API). O painel lê o banco pela string de conexão, e não pela API do Supabase.

Os nomes dos botões podem mudar no painel do Supabase. O que importa: cadastro público desligado, e-mail confirmado obrigatório.

**Passo 2. Reúna os dados do projeto.**

- A URL do projeto e a chave pública (anon), nas configurações da API.
- A string de conexão do Postgres, no botão **Connect**. Use a do **Session pooler**, porta 5432, que funciona em máquinas sem IPv6. A conexão direta do Supabase só tem IPv6. A do **Transaction pooler** (porta 6543) deveria servir, porque o código não usa consultas preparadas, mas não foi testada.
- Acrescente `?sslmode=require` ao fim da string. Se a senha tiver caracteres especiais, escreva-os codificados (`@` vira `%40`).

**Passo 3. Preencha o `.env`.**

```bash
AUTH_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=<URL do projeto>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<chave pública anon>
ADMIN_EMAILS=alguem@example.com,outra-pessoa@example.com
DATABASE_URL=postgres://USUARIO:SENHA@HOST:5432/postgres?sslmode=require
```

`ADMIN_EMAILS` é a lista de e-mails que entram como administrador, separados por vírgula. Maiúsculas e espaços não importam. Lista vazia: ninguém entra.

Mesmo no modo `supabase`, o Compose exige `POSTGRES_PASSWORD`, `WAHA_API_KEY`, `WAHA_HOOK_HMAC_KEY` e `SESSION_SECRET` preenchidos. O Compose não sabe exigir o `SESSION_SECRET` só no modo `password`, então quem usa o Supabase também precisa preenchê-lo. Ele não é usado nesse modo: qualquer valor de 32 caracteres serve.

**Passo 4. Aponte o Compose para o banco do Supabase.** O Compose sempre monta o `DATABASE_URL` com o `postgres` interno e ignora o `.env`. Para trocar, crie o arquivo `infra/docker-compose.supabase.yml` com este conteúdo:

```yaml
services:
  migrate:
    environment:
      DATABASE_URL: ${DATABASE_URL:?defina DATABASE_URL no .env}
    networks: [egress]
  web:
    environment:
      DATABASE_URL: ${DATABASE_URL:?defina DATABASE_URL no .env}
  worker:
    environment:
      DATABASE_URL: ${DATABASE_URL:?defina DATABASE_URL no .env}
```

O `migrate` precisa da rede `egress` porque a rede interna não tem saída para a internet. Daqui em diante, todo comando `docker compose` deste guia leva os dois arquivos:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.supabase.yml up -d --build
```

O `postgres` do Compose sobe mesmo assim, mas ninguém o usa. Os backups do banco passam a ser os do Supabase. O `--build` é necessário porque `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` entram na imagem do painel na hora de montá-la.

**Passo 5. Confira as migrações.** O serviço `migrate` cria o schema `mag` e as tabelas no banco do Supabase, com a segurança por linha (RLS) ligada e nenhuma política. Só a conexão do painel, que é a dona das tabelas, lê e escreve. Confira:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.supabase.yml logs migrate
```

O esperado é que a última linha seja `migrations ok`. Fora do Docker, o mesmo se faz com `DATABASE_URL=... pnpm --filter @mag/db run db:migrate`, que precisa de Node e pnpm e não lê o `.env`: defina a variável no terminal.

**Passo 6. Teste o acesso.** Entre com um usuário que está em `ADMIN_EMAILS`. Depois tente com um usuário do Supabase que não está na lista: ele deve ser recusado.


## 5. Entrar no painel

Abra o painel, entre com o e-mail e a senha de administrador e confira o menu: **Contas**, **Operações**, **Maturador**, **Anti-golpista** e **Bloqueados**.

## 6. Conectar os chips

1. Abra **Contas**.
2. Digite um nome em **Nome da nova conta** e clique em **Criar conta**.
3. Na linha da conta, clique em **Conectar**. Aparece um QR code.
4. No celular do chip: **Dispositivos conectados** → **Conectar dispositivo**, e aponte a câmera para o QR code. O QR muda a cada poucos segundos. Se os QR codes expirarem, clique em **Gerar novo ciclo de QR**.
5. Espere o status da conta virar **Conectada** e o número aparecer. O celular precisa ficar com internet até lá.
6. Repita para cada chip.

Para tirar uma conta, clique em **Remover**. O painel encerra a sessão no WhatsApp e só depois apaga a conta. Se o WhatsApp não encerrar a sessão, aparece o aviso "Não foi possível encerrar a sessão no WhatsApp" e a conta fica. Tente de novo em instantes.

Para o Anti-golpista, marque uma conta como espiã com **Marcar como espiã**. Veja [anti-golpista.md](anti-golpista.md). Contas espiãs não participam do Maturador.

Se o segundo chip não conectar, lembre que o número de sessões simultâneas depende da edição e da versão do WAHA em uso. Veja o aviso sobre vários chips no [README](../README.md#avisos).

## 7. Testar sem enviar nada ao WhatsApp

O motor simulado deixa você conhecer o painel sem risco. Ele não fala com o WhatsApp: as contas e os grupos são de mentira.

O Compose de produção força `WA_FAKE_ENGINE` vazio, então o motor simulado só vale rodando o painel fora do Docker, para desenvolvimento. Com Node.js 22 e pnpm 10.33, num terminal Git Bash ou Linux:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
pnpm install
set -a; source .env; set +a
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5544/postgres
export REDIS_URL=redis://127.0.0.1:6399
export WA_FAKE_ENGINE=1
pnpm --filter @mag/db run db:migrate
pnpm --filter @mag/web dev
```

Em outro terminal, com as mesmas variáveis exportadas, rode também `pnpm --filter @mag/worker dev`. O painel abre em `http://localhost:3100`. O `.env` precisa de `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `SESSION_SECRET` válidos.

O motor simulado é só para desenvolvimento: nada sai para o WhatsApp e as sessões ficam na memória de cada processo (painel e worker têm cada um o seu). Reiniciar o painel perde as sessões, e um chip em "Aguardando QR" pede um novo ciclo de QR. Nunca ponha números reais nesse modo e nunca use `WA_FAKE_ENGINE=1` em produção.

## Proxy reverso e HTTPS

Para acessar o painel pela internet, ponha na frente dele um proxy reverso com HTTPS. O painel escuta em `127.0.0.1:3100`, então o proxy precisa rodar na mesma máquina.

Faça três coisas:

1. **Exponha só o painel.** Aponte o proxy para `http://127.0.0.1:3100`. O WAHA não precisa ser exposto, e o caminho `/api/wa/events` também não: o WAHA o chama pela rede interna. Se o seu proxy expuser esse caminho de qualquer forma, limite o tamanho do corpo das requisições.
2. **Ajuste `APP_URL`.** Coloque o endereço público, por exemplo `https://painel.example.com`. Com `APP_URL` começando por `https://`, o cookie de sessão sai com a marca `Secure`. Se você abrir o painel por `http://` com `APP_URL` em `https://`, o navegador descarta o cookie e o login volta para a tela de entrada sem aviso. Com `APP_URL` em `http://`, o cookie sai sem `Secure`, o que é inseguro num servidor com HTTPS.
3. **Defina `TRUST_PROXY=1`, só se o proxy sobrescreve o `X-Forwarded-For`.** Com `TRUST_PROXY=1`, o painel usa o último item do `X-Forwarded-For` como IP do visitante, para o limite de tentativas de login e para o limite da página pública de verificação. Se o proxy repassar o cabeçalho que o visitante mandou, qualquer um fingiria ser outro IP. Sem `TRUST_PROXY=1`, o painel ignora o cabeçalho.

Exemplo com Caddy, que emite o certificado sozinho:

```caddyfile
painel.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

O Caddy substitui o `X-Forwarded-For` que vem do visitante. Com ele, `TRUST_PROXY=1` é seguro.

Exemplo com nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 2m;
}
```

Depois de mudar o `.env`, aplique:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

A página pública de verificação (`/verificar/<código>`) e a entrada (`/login`) são as únicas páginas abertas sem sessão, fora o recebimento dos avisos do WAHA.

## Backups

Tudo o que importa está em dois volumes: `postgres_data` (as suas configurações, listas, incidentes e histórico) e `waha_sessions` (os chips conectados). Se perder o segundo, você precisa ler os QR codes de novo.

Backup do banco, com o sistema no ar. Prefira o `pg_dump` a copiar a pasta do volume: copiar os arquivos do Postgres enquanto ele roda pode gerar uma cópia inconsistente.

O comando:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec postgres sh -c "pg_dump -U postgres -d postgres -Fc -f /tmp/mag.dump"
docker compose --env-file .env -f infra/docker-compose.yml cp postgres:/tmp/mag.dump ./mag.dump
```

Guarde o arquivo `mag.dump` num lugar seguro, fora da máquina. Os comandos geram o arquivo dentro do contêiner e o copiam, o que evita problemas de codificação com o redirecionamento do PowerShell. Faça isso antes de cada atualização.

Para restaurar num banco vazio, com o sistema parado (`docker compose ... stop web worker`):

```bash
docker compose --env-file .env -f infra/docker-compose.yml cp ./mag.dump postgres:/tmp/mag.dump
docker compose --env-file .env -f infra/docker-compose.yml exec postgres pg_restore -U postgres -d postgres --clean --if-exists /tmp/mag.dump
```

Backup do volume das sessões do WhatsApp, com o `waha` parado:

```bash
docker compose --env-file .env -f infra/docker-compose.yml stop waha
docker run --rm -v maturador-antigolpista_waha_sessions:/dados -v "$(pwd)":/backup alpine tar czf /backup/waha_sessions.tgz -C /dados .
docker compose --env-file .env -f infra/docker-compose.yml start waha
```

No PowerShell, troque `$(pwd)` por `${PWD}`. O arquivo `.env` guarda os segredos: faça backup dele também, em outro lugar.

## Atualizar para uma nova versão

1. Faça o backup do banco, como acima.
2. Baixe a versão nova (`git pull`, ou substitua os arquivos).
3. Compare o `.env.example` novo com o seu `.env` e copie as variáveis que apareceram.
4. Suba de novo:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml up -d --build
   ```

5. Confira `docker compose --env-file .env -f infra/docker-compose.yml logs migrate`. O esperado é que a última linha seja `migrations ok`.

As atualizações do banco só avançam. Para voltar a uma versão antiga, restaure o backup feito antes.

## Problemas comuns

| Sintoma | O que verificar |
|---|---|
| O Compose diz `required variable ... is missing` | Falta a opção `--env-file .env`, ou a variável está ausente do `.env`. |
| O painel não abre | `docker compose ... ps` mostra o `web` em execução? Veja `logs web`. O `web` só sobe depois do `migrate` terminar e do `waha` ficar saudável. |
| "Configuração incompleta" na entrada | `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10 caracteres ou mais) e `SESSION_SECRET` (32 ou mais) preenchidos? |
| A entrada volta para a mesma tela, sem erro | `APP_URL` está em `https://` e você abriu por `http://`. Ajuste `APP_URL` ou abra por HTTPS. |
| "Muitas tentativas" na entrada | Espere 15 minutos. Sem `TRUST_PROXY=1`, o limite é de todos juntos. |
| O Anti-golpista não reage a nada | O webhook chega? Confira `WAHA_HOOK_HMAC_KEY`. O painel responde 401 a assinatura errada ou chave ausente, e 413 a aviso grande demais: veja `logs web` e `logs waha`. Os grupos estão em **Grupos monitorados**? |
| A conta não conecta | O WAHA está no ar? Confira `WAHA_API_KEY`, o celular com internet e se o WAHA aceita várias sessões. |
| Erro de banco | Veja `logs migrate`. O `postgres` está saudável? |
