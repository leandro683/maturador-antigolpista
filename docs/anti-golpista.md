# Anti-golpista: como funciona e como configurar

O Anti-golpista vigia os grupos de WhatsApp de cada **Operação**. Ele reage a mensagens, promoções, mudanças de nome e entradas de gente suspeita. Depois registra tudo e age conforme a configuração: só anotar, pedir a sua decisão ou remover sozinho.

Em dúvida, ele não remove. Quando falta informação, o caso vira um achado para você decidir.

## Onde ficam as coisas no painel

| Onde | O que tem |
|---|---|
| **Contas** | Marcar um chip como **Espiã**. |
| **Operações** | Criar a Operação, escolher os chips e os grupos. Ao abrir uma Operação há três abas: **Grupos e chips**, **Anti-golpista** e **Colaboradores**. |
| **Operações**, aba **Anti-golpista** | Ligar a proteção e ajustar todas as regras daquela Operação. Também mostra o botão **Analisar grupos** daquela Operação. |
| **Anti-golpista** (menu lateral) | O histórico de tudo o que a ferramenta fez e os achados esperando decisão. Também tem o **Analisar grupos** de qualquer Operação, as **Regras gerais do anti-spam** e a adesão de cada Operação ao **Anti-spam compartilhado**. |
| **Bloqueados** | As listas de números bloqueados e a aba **Números administrativos**. |

## Antes de ligar

A chave **Ativar anti-golpista** só liga depois de dois itens. Até lá o painel mostra "Ative uma conta espiã e cadastre os números administrativos".

1. **Um chip espião** na Operação. Em **Contas**, clique em **Marcar como espiã** na conta. Depois, em **Operações**, abra a Operação, aba **Grupos e chips**, marque a conta em **Chips da operação** e clique em **Salvar chips**.
2. **Os números administrativos.** São os números das pessoas de confiança: donos, administradores e a equipe. Cadastre em **Bloqueados**, aba **Números administrativos**, com o número e uma identificação, por exemplo "Suporte". Quem não está na lista oficial (veja [A lista oficial](#a-lista-oficial)) pode ser tratado como suspeito. Sem ela, quase tudo parece suspeito.

Além disso:

3. Em **Operações**, aba **Grupos e chips**, clique em **Buscar grupos do WhatsApp**, escolha um dos chips, marque os grupos e clique em **Monitorar selecionados**. Cada importação aceita até 200 grupos. Os que já são monitorados aparecem marcados e travados, com a etiqueta "monitorado". Os que já estão em outra Operação aparecem com "em outra operação" e não podem ser marcados. Para parar de vigiar um grupo, use **Remover** na lista **Grupos monitorados**. Isso não mexe no grupo do WhatsApp. Só os grupos que aparecem em **Grupos monitorados** são vigiados. Eventos de outros grupos são ignorados.

Para o chip conseguir apagar mensagens e remover pessoas, ele precisa ser administrador do grupo no WhatsApp. Quando ele não consegue, a ação aparece com um ✗ na coluna **Ação tomada** do histórico.

### Teste primeiro no modo simulação

Em **Ao detectar**, a chave **Modo simulação** registra o que a ferramenta faria, sem apagar nem remover ninguém. No histórico, esses casos aparecem com o status **Simulação**.

Deixe o modo simulação ligado por alguns dias. Confira o histórico. Só depois desligue.

O modo simulação também segura a análise automática diária: com ele ligado, a análise automática não roda. A análise manual nunca age sozinha, com ou sem simulação.

## O que cada detecção faz

Estas regras valem para os grupos monitorados da Operação, quando **Ativar anti-golpista** está ligado. Cada ação depende das chaves da seção **Ao detectar**.

| Situação | O que acontece | Chave que controla |
|---|---|---|
| **Mensagem de quem não está na lista oficial**, em grupo fechado (só administradores falam) | A mensagem é apagada, o autor é removido do grupo e o número é bloqueado. Antes de agir, o sistema confirma com o WhatsApp que o grupo está mesmo fechado. | **Apagar mensagem de quem não é admin**, **Remover o autor do grupo** |
| **Mensagem suspeita**, em grupo aberto | Só age se a mensagem bater com um dos **Padrões suspeitos**. Os padrões iniciais pegam links, `www`, convites de grupo, "pix", "chave pix" e "convite". | **Com o grupo aberto, agir em mensagens suspeitas** |
| **Promoção não autorizada** | Quem foi promovido sem estar na lista oficial é rebaixado. Quem fez a promoção também é rebaixado, se não for de confiança. Se a chave de remoção estiver ligada, são removidos os que têm telefone confirmado. Gera um alerta. | **Proteger administradores**, **Remover o autor do grupo** |
| **Chip da Operação rebaixado ou removido** por alguém que não é de confiança | O sistema recoloca o chip no grupo (se foi removido) e o promove de novo, usando outro chip conectado. O autor é rebaixado e removido, se tiver telefone confirmado. Gera um alerta crítico. | **Proteger administradores**, **Remover o autor do grupo** |
| **Nome ou descrição do grupo alterados** por quem não é de confiança | O nome e a descrição voltam ao valor que o painel tem guardado para o grupo. Descrição guardada em branco também conta como valor guardado: uma descrição nova de quem não é de confiança volta a ficar em branco. O autor é rebaixado e removido, se tiver telefone confirmado. Só uma alteração feita por quem é de confiança passa a valer como o novo valor guardado. Se a mesma pessoa repetir a alteração mais tarde, ela é revertida e registrada de novo. | **Restaurar nome e descrição alterados por estranhos**, **Remover o autor do grupo** |
| **Link de convite trocado** por quem não é de confiança | Vira um incidente crítico e um alerta. O sistema **não consegue** revogar o link. Troque o link pelo próprio WhatsApp. | sempre registra |
| **Número bloqueado que entra no grupo** | É removido logo depois de entrar. | **Remover números bloqueados que entrarem** |
| **Impostor na entrada** (foto ou nome de golpista) | Veja [Impostores](#impostores-foto-e-nome). | modo de impostores |

Observações:

- Se o autor só tem o identificador LID e o sistema não descobre o telefone, ele não é punido. Sem telefone não dá para conferir a lista oficial. O caso vira um achado em aberto, esperando a sua decisão.
- A regra de grupo fechado age sobre quem escreve e não está na lista oficial, mesmo que seja administrador do grupo. É o caso de um administrador falso.
- A remoção de **números bloqueados que entram** segue as mesmas regras das outras ações automáticas: só age com **Ativar anti-golpista** ligado e a chave **Remover números bloqueados que entrarem** ligada. Com a proteção desligada, o bloqueado fica no grupo. No **Modo simulação**, nada é removido e o incidente é registrado como simulado.
- **Alertar no painel** grava um alerta no banco de dados para promoções, chips rebaixados e convite trocado. Este repositório não tem uma tela para ler os alertas. O que você acompanha é o histórico da tela **Anti-golpista**.
- A proteção por reações (apagar mensagem a partir de uma reação da equipe) existe no código, vem desligada e não tem chave no painel.
- Para evitar laços, a ferramenta limita as ações em cada grupo. Quando o limite estoura, o incidente aparece com o status **Limite de reações**.

### Padrões que você pode editar

- **Padrões suspeitos**: expressões regulares, uma por linha, sem diferenciar maiúsculas de minúsculas. Até 30, de até 200 caracteres cada.
- **Outros números que podem ser admin**: números extras que contam como lista oficial só nesta Operação. Um por linha, até 200.

## A lista oficial

É quem a ferramenta trata como de confiança. Nunca é punido por estas regras.

- Os **Números administrativos** (aba em **Bloqueados**).
- Os **colaboradores** da Operação (aba **Colaboradores** da Operação).
- Os **chips** do painel. A ferramenta nunca trata uma conta sua como invasora.
- Os números do campo **Outros números que podem ser admin**.

## Quem age e quem consulta

- Quem apaga mensagens, rebaixa e remove é um chip conectado da Operação. Vai primeiro o chip dono do grupo, depois o que recebeu o evento, depois qualquer chip que não seja espião. O espião só age se não houver outro.
- Nas **Regras gerais do anti-spam**, a chave **Anti-spam: agir só pelas contas associadas à operação** vem ligada. Desligada, se nenhum chip da Operação está conectado no grupo, outra conta sua que esteja no grupo pode agir no lugar.
- **Consultas de perfil** (foto, nome e telefone de quem entra) seguem outra regra. Se a Operação tem chips espiões, só eles consultam, um de cada vez, em rodízio. O chip que remove nunca faz consulta. Sem nenhum espião conectado naquele momento, ninguém é consultado e o caso fica para a análise diária.
- **Chips de consulta de fora da Operação.** A configuração aceita até 10 contas de fora da Operação que também consultam no rodízio, sem virar espiãs. Assim, um chip de outra Operação ajuda sem perder o papel dele. Não há campo para isso no painel. A lista fica na configuração da Operação, no banco de dados (`impersonationLookupAccountIds`). Você não precisa dela para começar.
- Na entrada do grupo, cada chip de consulta faz no máximo 30 consultas de perfil por minuto. O que passar disso fica para a análise.

## Impostores: foto e nome

Golpistas entram nos grupos com a arte oficial de uma loja ou de um suporte, e com nomes como "Suporte" ou "Adm". Esta função compara a foto e o nome de quem entra com as referências que você cadastra.

### Modos

Em **Impostores**, na aba **Anti-golpista** da Operação, escolha em **Quando aparecer um impostor**:

- **Desligado**: nenhuma consulta de perfil. É o padrão.
- **Só revisar (não remove ninguém)**: os achados vão para a lista, esperando você.
- **Remover quem usa foto igual**: quem usa uma foto de referência é removido e bloqueado. Quem tem só nome suspeito vai para revisão.

A chave **Remover também quem tem só nome suspeito** vem desligada e só vale no modo de remoção. Ligada, o nome suspeito sozinho também remove e bloqueia. Nomes como "Atendimento" ou "Adm" podem ser de pessoas reais. Deixe desligada até conhecer o seu caso.

### Fotos de referência

Você cadastra até 20 fotos, cada uma com um rótulo de até 60 caracteres. Há duas formas:

- **Adicionar arquivo**: imagem PNG, JPG ou WebP, de até 1 MB.
- **Pegar foto do número**: o painel lê a foto de perfil daquele número com o primeiro chip conectado da Operação. Se o número não tem foto visível, o painel avisa.

A imagem não é guardada. Ficam salvos só o rótulo e uma impressão digital da imagem. A lista só vale depois de clicar em **Salvar**.

### Nomes suspeitos

Em **Nomes suspeitos (um por linha)**, uma expressão regular por linha, sem diferenciar maiúsculas de minúsculas. Até 30. Os iniciais pegam: "suporte", "adm", "admin", "administra" (também "adiministra"), "atendimento", "suporte oficial" e "atendimento oficial". O nome é cortado em 100 caracteres antes da comparação. Variações com erro de digitação precisam de um padrão próprio.

### Como o sistema decide

- **Foto igual** a uma referência é um achado crítico. **Só o nome suspeito** é um achado de aviso. A foto tem prioridade sobre o nome.
- Se o perfil não tem foto visível, ou a consulta falhou, o caso fica "sem dados". Falha nunca leva à remoção.
- Antes de qualquer remoção, o caso passa pela [trava de segurança](#a-trava-de-segurança).

### Análise automática uma vez por dia

A chave **Analisar os grupos sozinho uma vez por dia** liga a análise automática. Ela roda às **3h07**, no fuso da variável `APP_TZ` (padrão: `America/Sao_Paulo`). Confere só quem entrou nas últimas 48 horas e que o sistema viu entrar. Ao monitorar um grupo, quem já estava nele entra sem data de entrada e, por isso, não é conferido pela análise automática: só a análise manual olha esses membros. Remove e bloqueia o que achar, respeitando a lista oficial e a trava.

Ela só roda quando todas estas condições valem para a Operação:

- a Operação não está arquivada;
- **Ativar anti-golpista** está ligado;
- o modo de impostores é **Remover quem usa foto igual**;
- **Analisar os grupos sozinho uma vez por dia** está ligada;
- o **Modo simulação** está desligado.

Se uma análise já está em andamento na Operação, a automática pula aquela Operação.

Se o worker for reiniciado no meio de uma análise (por exemplo, ao atualizar o sistema), ela continua sozinha: a cada 3 minutos o worker procura análises sem atividade há mais de 5 minutos e devolve cada uma à fila. A retomada leva, no pior caso, cerca de 8 minutos, e o grupo que estava sendo lido é lido de novo.

## Analisar grupos (análise manual)

O botão **Analisar grupos** lê todos os grupos da Operação e procura:

- números bloqueados dentro do grupo;
- administradores que não estão na lista oficial;
- mensagens de quem não está na lista oficial, em grupo fechado;
- com a caixa **Conferir foto e nome dos participantes**, possíveis impostores. Essa caixa só funciona com a detecção de impostores ligada na Operação.

**Mensagens lidas por grupo** vai de 0 a 200. O padrão é 50.

A análise manual **só lê**. Não apaga, não remove e não bloqueia nada. Cada achado vira um incidente em aberto, com o status **Aguardando decisão**. Você decide cada um, por linha ou em lote:

- **Remover** ou **Remover participante**: tira a pessoa do grupo. Passa pela trava.
- **Remover e bloquear**: remove e coloca o número na lista de bloqueados da Operação.
- **Apagar** ou **Apagar mensagem**: apaga a mensagem, quando o achado é uma mensagem.
- **Ignorar** ou **Ignorar achados**: marca como resolvido. Um achado ignorado não volta a cada análise.

Cada clique em lote trata até 20 achados. Selecione o restante e repita.

A tela mostra o progresso (**grupos analisados** de **total**) e o botão **Cancelar**. O cancelamento vale entre um grupo e outro. Só uma análise roda por Operação de cada vez.

Os grupos são lidos um de cada vez, com pausa de 40 a 60 segundos entre eles. Ao conferir foto e nome, há uma pausa de 0,3 segundo entre uma pessoa e outra, e um grupo grande pode levar vários minutos. Rode fora do horário em que o chip trabalha.

Se o WhatsApp não devolve as mensagens recentes, a análise segue só com a lista de participantes, e a tela avisa o número de grupos afetados.

## A trava de segurança

Nenhuma remoção por impostor, nem pelo botão **Remover** de um achado, nem pela análise automática, acontece sem a confirmação positiva do próprio WhatsApp. A trava confere, nesta ordem, e para no primeiro "não":

1. Dá para ler as contas do painel e o grupo? Se não, não remove.
2. A pessoa aparece na lista de participantes do grupo? Se não, não remove.
3. Alguma das identidades dela (telefone ou LID) é administradora ou super-administradora? Se sim, não remove.
4. Ela está na lista oficial, ou é um chip do painel? Se sim, não remove.
5. Ela só tem identificador LID? O sistema tenta descobrir o telefone. Sem telefone confirmado, não remove sozinho: o caso fica para você.
6. Passou por tudo: remove.

Quando a trava recusa, o motivo aparece no incidente.

O que a ferramenta **nunca remove** por estes caminhos: administradores do grupo, os números administrativos, os colaboradores cadastrados e os chips do painel. A exceção está na regra de grupo fechado, descrita acima, que age sobre quem escreve fora da lista oficial.

## Bloqueados

A tela **Bloqueados** tem duas abas.

### Números bloqueados

- Os números ficam em **Listas**. Crie uma lista no campo **Nova lista**. **Ativar** e **Desativar** ligam e desligam a lista. **Excluir lista** apaga a lista e os números dela deixam de ser bloqueados.
- Cada Operação ganha sozinha uma lista chamada "Anti-hacker — <nome da Operação>". Os números que a ferramenta bloqueia vão para ela.
- Para bloquear um número, escolha uma lista, o tipo (**Telefone** ou **LID**), digite o número, o **Nome (opcional)** e clique em **Bloquear**.
- **Importar CSV**: colunas "telefone" e/ou "lid", mais "nome" (opcional). O separador pode ser vírgula ou ponto e vírgula. No máximo 5.000 linhas por importação.
- **Buscar número ou nome** procura em todas as listas.
- Quem está numa lista ativa é removido quando entra num grupo monitorado, se a proteção da Operação está ligada e a chave **Remover números bloqueados que entrarem** também. Os números são guardados com o `+` na frente (o painel acrescenta); a verificação aceita com ou sem ele.

### Números administrativos

A lista oficial de confiança. Digite o número e a **Identificação** e adicione. Esses números nunca são removidos nem bloqueados.

### Anti-spam compartilhado

É uma lista que reúne quem foi pego em qualquer Operação.

- Cada Operação escolhe entrar com a chave **Participar do anti-spam compartilhado** (na aba **Anti-golpista** da Operação) ou com a chave de cada Operação na seção **Anti-spam compartilhado** da tela **Anti-golpista**.
- A chave **Enviar o autor ao anti-spam compartilhado** manda quem for bloqueado também para essa lista.
- Em **Regras gerais do anti-spam**, **Lista de bloqueados compartilhada em todas as operações** (padrão: desligada) faz a lista valer em todas as Operações, com ou sem adesão. Cada mudança fica no histórico, e os processos usam a nova regra em até 1 minuto.

## Colaboradores e página pública de verificação

Na aba **Colaboradores** da Operação você cadastra os telefones oficiais da equipe. Eles contam como lista oficial para o anti-golpista.

- **Este número é colaborador?** confere um número e guarda a consulta no **Histórico de consultas**.
- **Novo colaborador** cadastra por **Telefone** ou **LID**. **Adicionar CSV** importa uma lista, de até 5.000 linhas. **Remover selecionados** tira da lista.
- Os chips da Operação aparecem em **Administradores dos chips da operação** e também contam como equipe.

### Página pública

Cada Operação tem uma página aberta, sem login, em `/verificar/<código>`. Qualquer pessoa digita um número e vê só "Este número é da equipe." ou "Este número NÃO é da equipe". A lista nunca aparece, nem nomes.

- A página nasce **desligada**. Para publicar, marque **Página pública ligada** e clique em **Salvar**. Desligada ou inexistente, a página responde "não encontrada".
- **Nome do evento (título da página)** é o título que a pessoa vê. Sem nome do evento, o título é "Verificação da equipe".
- O endereço usa um código aleatório de 10 caracteres. Cada consulta entra no histórico com a origem "publico".
- A página limita as consultas. Passando do limite, ela pede para esperar um minuto. O limite é de 120 consultas por minuto por página. Com `TRUST_PROXY=1` (atrás de um proxy reverso que informa o IP do visitante) vale também 10 por minuto por visitante. Sem isso, o IP do visitante é ignorado. Veja `TRUST_PROXY` na [instalação](instalacao.md#proxy-reverso-e-https).
- Os chips da Operação também respondem "da equipe". Quem consulta o número de um chip descobre que ele pertence à Operação.

## Histórico e achados

Na tela **Anti-golpista**:

- Os quatro números no alto: **Incidentes em aberto**, **Operações protegidas**, **Números administrativos** e **No anti-spam compartilhado**.
- Os filtros **Operação**, **Tipo**, **De**, **Até** e **Só em aberto**, com **Filtrar** e **Limpar**. As datas seguem o fuso de `APP_TZ`.
- A tabela, com **Data**, **Tipo**, **Participante**, **Operação / grupo**, **Ação tomada** e **Status**.
- **Exportar CSV** baixa até 500 incidentes dos filtros atuais.
- **Ignorar selecionados** e **Marcar como revertido** fecham incidentes. Use quando você já resolveu pelo WhatsApp.
- **Números com mais incidentes** mostra quem mais apareceu.

Tipos de incidente (o filtro **Tipo** usa estes nomes): **Mensagem de não-admin**, **Promoção não autorizada**, **Conta perdeu admin**, **Nome/descrição alterados**, **Bloqueado entrou**, **Auditoria de admins**, **Mensagem revelada por reação**, **Análise: bloqueado no grupo**, **Análise: mensagem de não-admin**, **Análise: admin desconhecido** e **Possível impostor**.

Status: **Ação tomada**, **Ação parcial**, **Falhou**, **Simulação**, **Limite de reações**, **Ignorado**, **Revertido** e **Aguardando decisão**.

## Limites conhecidos

- Quem entrou no grupo antes de o sistema estar ligado, ou antes de o grupo ser monitorado, não tem registro de entrada. Esse membro só é conferido pela análise manual.
- Quem troca a foto mais de 48 horas depois de entrar só é pego pela análise manual.
- Foto privada não pode ser comparada. Sobra só o nome, que vai para revisão.
- Uma troca legítima de nome ou descrição, feita por quem é de confiança, só vira o novo valor guardado se o painel receber o aviso a tempo. O WAHA desiste depois de 5 tentativas (cerca de 1 minuto), e o aviso também não vale se vier com mais de 10 minutos, sem o autor ou se a análise falhar. Nesse caso o painel continua com o nome antigo e restaura esse nome na próxima alteração de um estranho. Para atualizar, use **Remover** na lista **Grupos monitorados** e importe o grupo de novo; o painel ainda não tem um botão para atualizar a partir do WhatsApp.
- Um nome automático pode pegar um cliente real com nome parecido, como "Atendimento".
- Se o golpista trocar a arte, cadastre a nova foto de referência.
- Quando o chip da Operação é removido e o autor só tem LID, o chip é recolocado, mas o autor não é punido.
- O golpe por conversa privada não é visto por esta ferramenta. Ela atua só nos grupos.
- A ferramenta não revoga link de convite. Isso é feito no WhatsApp.

## O que ainda não foi validado com o WhatsApp real

Esta função foi escrita e testada com motores simulados. Antes de confiar nela, valide estes pontos com um grupo de teste e números seus:

1. O formato das respostas do WAHA para foto de perfil e nome.
2. O comportamento com foto privada e com identificadores LID.
3. Se o nome está disponível no momento em que a pessoa entra.
4. Se o grupo já lista quem acabou de entrar. Se não listar, a remoção automática não acontece. Tudo vai para revisão.
5. Se a comparação de fotos funciona com a arte recomprimida, como ela chega de fato no WhatsApp.
6. Se o telefone de quem acabou de entrar é resolvido a partir do LID.
7. Se a leitura das mensagens recentes funciona com o motor GOWS.

Enquanto esses pontos não forem validados, mantenha o **Modo simulação** ligado ou o modo de impostores em **Só revisar**.
