# Maturador + Anti-golpista

Duas ferramentas para quem usa WhatsApp com vários chips e com grupos de clientes.

**Maturador.** Faz pares de chips conversarem entre si, em português, com falas escritas por IA e espaçadas no tempo. Assim os números ganham histórico antes de receberem as suas Operações.

**Anti-golpista.** Vigia os grupos de cada Operação e reage a mensagens de quem não é da equipe, a promoções e mudanças de nome não autorizadas e a impostores com foto ou nome de suporte. Pode remover sozinho, mas só nos casos que você liga. Em dúvida, ele não remove.

Uma **Operação** é o conjunto de grupos e de chips de um mesmo trabalho. No painel, cada Operação tem as suas próprias regras.

Criado por Leandro Belarmino.

## Avisos

- **Risco de banimento.** Automatizar o WhatsApp pode fazer os seus números serem bloqueados ou banidos. Um banimento pode atingir vários chips de uma vez, porque eles ficam no mesmo servidor. Use por sua conta e risco. Comece com poucos chips que você aceite perder.
- **Sem vínculo.** Este projeto não é afiliado, patrocinado nem aprovado pelo WhatsApp, pela Meta ou pelo WAHA. O WAHA, que faz a ponte com o WhatsApp, também não é oficial.
- **Modo Supabase.** O login e o banco pelo Supabase são suportados, mas foram validados menos que o modo com Postgres comum. Faça um teste completo antes de usar com números importantes.
- **Vários chips.** O Maturador precisa de pelo menos dois chips, o que exige um WAHA que aceite várias sessões. O arquivo `infra/docker-compose.yml` usa por padrão a imagem `devlikeapro/waha:gows`. A tag `gows` muda com o tempo e não verificamos o que ela aceita hoje. Quantas sessões simultâneas o WAHA aceita depende da edição e da versão da imagem em uso, e o Maturador precisa de pelo menos duas. Se a conexão do segundo chip falhar, defina em `WAHA_IMAGE` uma imagem do WAHA que aceite várias sessões.
- **Não validado em produção.** O anti-golpista foi escrito e testado com motores simulados. Valide com um grupo de teste e números seus, e comece no modo simulação. Veja [docs/anti-golpista.md](docs/anti-golpista.md#o-que-ainda-não-foi-validado-com-o-whatsapp-real).

## Requisitos

- Uma máquina com **Docker** e **Docker Compose** versão 2 (o comando `docker compose`). Nada mais precisa estar instalado para rodar o sistema.
- Acesso à internet para baixar as imagens e para o WAHA falar com o WhatsApp.
- Um número de WhatsApp, com celular e chip, para cada chip que você vai conectar.
- Opcional: uma chave da OpenRouter (`OPENROUTER_API_KEY`) para o Maturador gerar as conversas.
- Só para desenvolver ou rodar os testes: Node.js 22 ou mais novo e pnpm 10.33.

## Início rápido

> **As imagens Docker ainda não foram montadas nem iniciadas em nenhuma máquina.** O caminho com Docker Compose foi validado só com `docker compose config`. A aplicação em si foi testada fora do Docker, com testes unitários, de banco de dados e de navegador. Quem montar as imagens primeiro, por favor relate os problemas que encontrar.

Baixe o projeto (`git clone` ou o ZIP do GitHub) e abra um terminal na pasta dele (Git Bash, PowerShell ou Linux). Depois:

1. Copie o modelo de configuração.

   ```bash
   cp .env.example .env
   ```

2. Gere os segredos. Rode o comando quatro vezes e guarde cada resultado. Ele usa só o Docker:

   ```bash
   docker run --rm node:22-slim node -p "require('crypto').randomBytes(32).toString('hex')"
   ```

3. Abra o arquivo `.env` num editor e preencha:

   | Variável | Valor |
   |---|---|
   | `POSTGRES_PASSWORD` | um dos segredos gerados |
   | `WAHA_API_KEY` | um dos segredos gerados |
   | `WAHA_HOOK_HMAC_KEY` | um dos segredos gerados |
   | `SESSION_SECRET` | um dos segredos gerados (mínimo de 32 caracteres) |
   | `ADMIN_EMAIL` | o seu e-mail de administrador |
   | `ADMIN_PASSWORD` | uma senha sua, de pelo menos 10 caracteres |

4. Suba os serviços. Na primeira vez isso baixa as imagens e monta o painel, e pode levar vários minutos:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml up -d --build
   ```

   O `--env-file .env` é obrigatório. O arquivo do Compose fica na pasta `infra`, e sem essa opção o Docker não lê o `.env` da raiz.

5. Confira se tudo subiu:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml ps
   ```

   O esperado é que os serviços `waha`, `redis`, `postgres`, `web` e `worker` estejam em execução e que o `migrate` termine sozinho (status `exited (0)`), depois de criar as tabelas do banco. Se algum serviço não subir, veja o motivo com `docker compose --env-file .env -f infra/docker-compose.yml logs <serviço>`.

6. Abra `http://localhost:3100` e entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`.

7. Em **Contas**, crie uma conta, clique em **Conectar** e leia o QR code com o WhatsApp do celular do chip.

O painel só aceita conexões da própria máquina (`127.0.0.1`). Para abrir pela internet, ponha um proxy reverso com HTTPS na frente. O passo a passo completo está em [docs/instalacao.md](docs/instalacao.md).

## Modos de login e de banco

O painel tem dois modos. Escolha um na variável `AUTH_MODE`:

| Modo | Como entra | Banco |
|---|---|---|
| `password` (padrão) | e-mail e senha do administrador (`ADMIN_EMAIL` e `ADMIN_PASSWORD`) | Postgres do Docker Compose |
| `supabase` | conta do Supabase; entra como administrador quem estiver em `ADMIN_EMAILS` e tiver o e-mail confirmado | Postgres do Supabase |

O modo `password` é o padrão. O modo `supabase` exige passos extras, descritos em [docs/instalacao.md](docs/instalacao.md#modo-supabase).

## Variáveis de ambiente

Elas ficam no arquivo `.env`, copiado de `.env.example`. A coluna "Onde vale" diz se a variável funciona com o Docker Compose ou só fora dele.

| Variável | Padrão | Onde vale | Para que serve |
|---|---|---|---|
| `APP_URL` | `http://localhost:3100` | Docker e fora | Endereço público do painel. Se começar com `https://`, o cookie de sessão sai com a marca `Secure`; abra o painel pelo mesmo endereço, senão o login volta para a tela de entrada. Também vai como `HTTP-Referer` nas chamadas à OpenRouter. Não é usada no webhook do WAHA. |
| `APP_TZ` | `America/Sao_Paulo` | Docker e fora | Fuso do agendador (a análise automática diária do Anti-golpista roda às 3h07 nesse fuso) e das datas dos filtros da tela Anti-golpista. Não muda o horário do Maturador, que usa sempre Brasília. |
| `WEB_PORT` | `3100` | Docker | Porta do painel em `127.0.0.1`. O contêiner sempre escuta na 3100. |
| `POSTGRES_PASSWORD` | obrigatória | Docker | Senha do Postgres do Compose. Só letras e números: o endereço do banco não aceita `@ : / ? #`. |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | fora do Docker | Endereço do Postgres. As tabelas ficam no schema `mag`. No Docker Compose o endereço é montado com o serviço `postgres` e este valor é ignorado. Para o banco do Supabase, veja a [instalação](docs/instalacao.md#modo-supabase). |
| `REDIS_URL` | `redis://127.0.0.1:6379` | fora do Docker | Endereço do Redis das filas. No Docker Compose é montado com o serviço `redis`. |
| `WAHA_URL` | `http://127.0.0.1:3001` | fora do Docker | Endereço do WAHA. No Docker Compose é montado com o serviço `waha`. |
| `WAHA_API_KEY` | obrigatória no Docker | Docker e fora | Chave de API do WAHA, enviada no cabeçalho `X-Api-Key`. |
| `WAHA_HOOK_HMAC_KEY` | obrigatória no Docker | Docker e fora | Segredo que assina os avisos do WAHA ao painel (`sha512`, cabeçalho `X-Webhook-Hmac`). Sem ele o painel recusa todos os avisos. |
| `WA_FAKE_ENGINE` | vazio | só fora do Docker | Com `1`, troca o WAHA por um motor simulado, só para desenvolvimento. Nada é enviado ao WhatsApp. As sessões ficam na memória de cada processo (painel e worker têm cada um o seu): reiniciar perde as sessões. O Compose força essa variável vazia. |
| `WAHA_IMAGE` | `devlikeapro/waha:gows` | Docker | Imagem do WAHA. O Maturador precisa de uma que aceite várias sessões. |
| `WAHA_PORT` | `3001` | Docker, só depuração | Porta do WAHA em `127.0.0.1`, publicada só com `infra/docker-compose.waha-debug.yml`. |
| `AUTH_MODE` | `password` | Docker e fora | `password` ou `supabase`. |
| `ADMIN_EMAIL` | vazio | Docker e fora | E-mail do administrador, no modo `password`. |
| `ADMIN_PASSWORD` | vazio | Docker e fora | Senha do administrador, no modo `password`. Mínimo de 10 caracteres. |
| `SESSION_SECRET` | obrigatória no Docker | Docker e fora | Segredo que assina a sessão, no modo `password`. Mínimo de 32 caracteres. O Compose não consegue exigir só no modo `password`: no modo `supabase` você também precisa preencher (qualquer valor de 32 caracteres), embora ele não seja usado. |
| `TRUST_PROXY` | vazio | Docker e fora | Com `1`, o painel usa o último item de `X-Forwarded-For` como IP do visitante nos limites de tentativas (login e página pública). Use só atrás de um proxy que sobrescreve esse cabeçalho. Vazio: o cabeçalho é ignorado, e o limite do login é um só para todos. |
| `NEXT_PUBLIC_SUPABASE_URL` | vazio | Docker e fora | Endereço do projeto Supabase, no modo `supabase`. Entra no painel ao montar a imagem: mudou, suba com `--build`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | vazio | Docker e fora | Chave pública (anon) do Supabase. Mesmo cuidado com `--build`. |
| `ADMIN_EMAILS` | vazio | Docker e fora | E-mails de administrador, separados por vírgula, no modo `supabase`. Só entra quem estiver na lista e tiver o e-mail confirmado. |
| `OPENROUTER_API_KEY` | vazio | Docker e fora | Chave da OpenRouter, que gera as conversas do Maturador. Vazia: o Maturador não gera conversas. |
| `OPENROUTER_API_KEY_MATURADOR` | vazio | Docker e fora | Chave só do Maturador. Sem ela vale `OPENROUTER_API_KEY`. |
| `LLM_TIMEOUT_MS` | `120000` | Docker e fora | Tempo máximo, em milissegundos, de uma chamada à IA. |
| `WHATSAPP_DEFAULT_ENGINE` | `GOWS` | Docker | Motor do WAHA para as sessões novas. |
| `WEB_IMAGE`, `WORKER_IMAGE` | `mag/web:latest`, `mag/worker:latest` | Docker | Nomes das imagens montadas. |
| `POSTGRES_PORT`, `REDIS_PORT` | `5544`, `6399` | Compose de desenvolvimento | Portas do Postgres e do Redis em `127.0.0.1` em `infra/docker-compose.dev.yml`. |
| `TEST_DATABASE_URL` | vazio | testes | Postgres que os testes usam. |
| `LEAK_DENYLIST` | vazio | `pnpm leak-check` | Arquivo local com a lista proibida do verificador de dados pessoais. |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_MODEL_EXTRACAO` | vazio | sem efeito no Maturador | O pacote de IA as lê, mas o Maturador força a OpenRouter e escolhe o modelo pelo painel. |
| `NEXT_OUTPUT` | `standalone` na imagem | montagem do painel | Define a saída standalone. A imagem Docker já define. |

Nunca publique o arquivo `.env` nem os seus valores.

## Testes

Os testes precisam de Node.js 22 ou mais novo, pnpm 10.33, um Postgres e um Redis. O Compose de desenvolvimento sobe os dois, só em `127.0.0.1`:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
pnpm install
```

Defina os endereços de teste e rode:

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5544/postgres
export REDIS_URL=redis://127.0.0.1:6399
pnpm test
```

No PowerShell, use `$env:TEST_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5544/postgres"` e `$env:REDIS_URL = "redis://127.0.0.1:6399"`.

Outros comandos, todos na raiz:

```bash
pnpm typecheck                              # confere os tipos
pnpm lint                                   # confere o estilo do código
pnpm build                                  # gera a versão de produção do painel
pnpm leak-check                             # procura dados pessoais nos arquivos
node --test scripts/leak-check.test.mjs     # testa o próprio verificador
```

Sem `TEST_DATABASE_URL`, os testes que usam banco ficam de fora.

## Documentação

- [Instalação passo a passo](docs/instalacao.md)
- [Maturador: como funciona e como configurar](docs/maturador.md)
- [Anti-golpista: como funciona e como configurar](docs/anti-golpista.md)

## Crédito e licença

Criado por Leandro Belarmino. O rodapé do painel mostra esse crédito, que deve ser mantido.

Este projeto usa a licença de uso do arquivo [LICENSE](LICENSE). Em resumo: você pode usar e adaptar o software no seu próprio negócio, desde que mantenha o arquivo de licença e o crédito. Não pode revender, sublicenciar nem oferecer o software a terceiros como produto ou serviço hospedado. Não pode repassar uma cópia a terceiros, mesmo de graça, sem autorização prévia e por escrito do autor; quem recebeu o software diretamente do autor pode usá-lo no próprio negócio nestes termos. Não pode usar o nome do autor para promover versões derivadas sem autorização por escrito. O software vem sem garantia, inclusive contra números bloqueados pelo WhatsApp. A licença termina se você descumprir qualquer condição.
