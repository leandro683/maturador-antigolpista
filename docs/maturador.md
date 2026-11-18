# Maturador: como funciona e como configurar

O Maturador faz os seus chips conversarem entre si, devagar e em português. Essas conversas dão histórico aos números antes de eles receberem as suas Operações.

A tela fica no menu lateral, em **Maturador**. A página se chama **Maturador de chips**. Só o administrador do painel tem acesso.

Aquecer um chip não garante que ele não seja banido. O WhatsApp não permite automação e pode banir vários chips de uma vez. Leia os [riscos](#riscos) antes de ligar.

## O que precisa estar pronto

- Pelo menos **2 contas** criadas e conectadas em **Contas**. Veja [instalação](instalacao.md#6-conectar-os-chips).
- Cada conta com o número já sincronizado. Se não estiver, ao marcar a conta o painel avisa: "Esta conta ainda não tem número sincronizado. Reconecte a conta antes de usar no maturador."
- Contas **Normal**. Uma conta marcada como **Espiã** não envia mensagens, e o Maturador a pausa com o motivo "papel da conta não permite envio".
- A chave `OPENROUTER_API_KEY` no `.env`. Sem ela a página mostra o aviso "Integração desligada" e nenhuma conversa é gerada.
- Um WAHA que aceite mais de uma sessão. Veja o [README](../README.md#avisos).

O Maturador vem **desligado**. Nada acontece até você clicar em **Ligar**.

## Como as conversas acontecem

1. Você marca em **Chips** quais contas participam (coluna **Participa**).
2. O sistema cria sozinho um par para cada dupla de chips participantes. Você não monta pares à mão. A lista fica em **Pares automáticos**, em "Ver todos os pares".
3. Um par só começa a conversar depois que os dois chips confirmaram os contatos (veja [Contatos salvos](#contatos-salvos)).
4. A cada conversa, o sistema sorteia um tema ativo, que não repete o último daquele par.
5. A IA escreve as falas, o sistema espera o tempo configurado e envia, alternando os chips.

Um chip fala em uma conversa por vez. O campo **Conversas ao mesmo tempo** limita quantas conversas rodam juntas (padrão 3).

### Modo de trabalho

Em **Modo de trabalho** escolha uma opção e clique em **Salvar configuração**, mais abaixo na página.

- **Por fila (roteiro)**: a IA escreve de uma vez uma conversa curta entre os dois chips. O sistema envia as falas alternando os chips, com intervalos aleatórios. Gasta pouco: uma chamada de IA por conversa. É o padrão e o indicado para IA gratuita.
- **IA respondendo de verdade**: um chip puxa assunto e cada mensagem recebida é lida e respondida pela IA, depois do tempo de leitura e de digitação. Fica mais natural, mas faz uma chamada de IA por mensagem e gasta a cota gratuita bem mais rápido.

### Contatos salvos

Duas pessoas de verdade só conversam depois de salvar o número uma da outra. O Maturador imita isso.

Na coluna **Contatos salvos**, cada chip participante mostra o botão **Salvei os números**. Salve, no celular de cada chip, o número de todos os outros chips. Depois clique no botão. Quando você marca um chip novo em **Participa**, o painel avisa "Entrou chip novo: salve o número dele neste aparelho." Os chips mais antigos precisam confirmar de novo.

## Ritmo e limites

Tudo isto fica em **Segurança de tempo**. Os valores abaixo são os padrões. Clique em **Salvar configuração** para aplicar.

| Campo | Padrão | Regra |
|---|---|---|
| Intervalo mínimo e máximo (s) | 45 e 180 | O mínimo nunca é menor que 15 s. O máximo é no máximo 1800 s (30 min). |
| Pausa entre conversas mínima e máxima (min) | 10 e 40 | Tempo de descanso do par depois de uma conversa. |
| Falas por conversa mínimo e máximo | 6 e 14 | De 2 a 40. |
| Velocidade de digitação (caracteres por segundo) | 5 | De 1 a 20. Entra no tempo de espera antes de cada resposta. |
| Janela: início e fim (hora) | vazio | De 0 a 23, no horário de Brasília. Vazio significa 24 horas. Se o início for maior que o fim, a janela atravessa a meia-noite. O fim não entra na janela. |
| Conversas ao mesmo tempo | 3 | De 1 a 10. |

Uma conversa parada há mais de 60 minutos é encerrada.

### Meta diária de cada chip

Cada chip tem uma meta de falas por dia e um limite de parceiros diferentes por dia. Ambos sobem devagar com o tempo de casa do chip no Maturador:

| Dia no Maturador | Falas por dia | Parceiros diferentes por dia |
|---|---|---|
| 1 | 60 | 2 |
| 2 | 80 | 2 |
| 3 a 5 | 100 | 3 |
| 6 a 10 | 100 | 5 |
| 11 em diante | 100 | sem limite |

A tabela **Chips** mostra, para cada chip, "Dia N · meta X falas, Y parceiros" e a barra **Subida** com as falas de hoje sobre a meta. O dia conta em blocos de 24 horas a partir de quando o chip entrou. O "hoje" da meta segue o horário de Brasília. Quando um chip bate a meta, ele não começa novas conversas até o dia seguinte.

O horário de Brasília do Maturador é fixo. A variável `APP_TZ` não o altera.

## Conversas geradas por IA

As conversas são geradas pela OpenRouter, com a chave `OPENROUTER_API_KEY`. Se quiser uma chave só para o Maturador, use `OPENROUTER_API_KEY_MATURADOR`. O Docker Compose repassa as duas ao `worker` (vazias por padrão). Veja o [README](../README.md#variáveis-de-ambiente).

### Modelos de IA

Os modelos vêm de uma lista fechada. Você escolhe quais usar, mas não adiciona modelos novos.

- **Gratuitos principais (rodízio)**: NVIDIA Nemotron 3 Ultra, NVIDIA Nemotron 3.5 Super VL e Google Gemma 4 26B. Eles se revezam entre as conversas.
- **Gratuitos de reserva**: Dots 3 Note, NVIDIA Nemotron 3.5 Lightning e Google Gemma 4 31B. Só entram se os principais falharem.
- **Backup pago**: Mistral Nemo, Mistral Small 24B e GLM 5.3 Flash. Só entram quando nenhum gratuito responde, e só com a caixa **Usar quando nenhum gratuito responder** ligada.

Em **Escolher modelos gratuitos** você marca os gratuitos. É preciso manter pelo menos um. Cada modelo pago tem a sua caixa. Clique em **Salvar modelos**.

**Teto de gasto pago por dia (US$)** limita o gasto com os modelos pagos. O padrão é 1,00. O painel mostra "Gasto pago hoje: X de Y".

### Quando a IA para

Se nenhum modelo responde, o Maturador inteiro pausa e a faixa de situação mostra o motivo:

- **Pausado: cota gratuita esgotada**: os gratuitos falharam e o backup pago está desligado.
- **Pausado: teto pago do dia atingido**: o gasto pago de hoje chegou ao teto.
- **Pausado: nenhum modelo respondeu**: todos falharam, mesmo com o backup.

O Maturador volta sozinho às **21:00 de Brasília** (meia-noite UTC), que é quando a cota da OpenRouter e o teto do dia recomeçam. Quando a conversa usa um modelo pago, a faixa mostra "Rodando no backup pago".

### Filtro das falas

Uma fala da IA é descartada, e não enviada, se tiver link, número de telefone, e-mail, palavrão ou letras de outro alfabeto. Falas com mais de 300 caracteres são cortadas. Em modo **Por fila**, o roteiro precisa ficar com pelo menos 2 falas válidas.

## Temas

A seção **Temas** lista os temas das conversas. O banco já vem com vários temas leves, como séries, viagens e filmes.

- Para criar, clique em **+ Novo tema**, preencha **Nome do tema** (até 80 caracteres) e **O que pode falar** (até 1000), e clique em **Salvar tema**.
- Para mudar um tema, abra **Editar**.
- A chave de cada tema liga e desliga o tema. Sem nenhum tema ativo, nada começa.

Há uma lista fixa do que os chips **nunca** falam, válida para todos os temas: links, vendas, preço, dinheiro, Pix, política, religião, telefones, e-mails, propaganda, palavrões e temas sensíveis da Meta (saúde, sexo, drogas, armas, apostas, crédito e aparência). Evite temas que puxem placares, datas ou números, porque a IA costuma inventar.

## Ligar, pausar e acompanhar

- A faixa no alto mostra a situação: **Desligado**, **Ligado**, **Pausado** ou **Rodando no backup pago**.
- **Ligar** começa a criar conversas.
- **Pausar tudo** desliga o Maturador, encerra as conversas em andamento e descarta as falas pendentes. Para recomeçar, clique em **Ligar**.
- **Últimas mensagens** mostra as 30 mais recentes entre os chips, em horário de Brasília, com hora, quem enviou, quem recebeu, tema, modelo, texto e o estado **Enviada** ou **Falhou**.

### Situação de cada chip

| Selo | Significado |
|---|---|
| **Aquecendo** | Participa e está conversando. |
| **Pausado: <motivo>** | O Maturador tirou o chip da rotação. Veja abaixo. |
| **Conta desconectada** | A conta não está conectada ao WhatsApp agora. |
| **Restrito** ou **Restrito — não participa** | O WhatsApp restringiu a conta. Ela não participa. |
| **Fora do maturador** | A conta existe, mas a chave **Participa** está desligada. |

Quando uma conta cai por pouco tempo, a fala é adiada de minuto em minuto. Passados 10 minutos, o chip é pausado com o motivo **desconectado**. Esse tipo de pausa se desfaz sozinho 5 minutos depois, se a conta voltar a ficar em ordem.

Estas pausas **não** se desfazem sozinhas:

- **restrito**: insistir num chip restrito aumenta o risco de banimento;
- **papel da conta não permite envio**: a conta está como Espiã;
- **tirado por você**: você desligou a chave **Participa**.

Para trazer o chip de volta, resolva a causa e ligue **Participa** de novo.

Antes de enviar cada fala, o sistema reserva o turno no banco. Assim, a mesma fala não é enviada duas vezes.

## Como começar com segurança

1. Conecte as contas e confira que todas estão com o número sincronizado.
2. Comece com **2 chips**, números que você aceita perder.
3. Em **Chips**, ligue **Participa** nos dois. Salve os números nos celulares e clique em **Salvei os números** nos dois.
4. Deixe o **Modo de trabalho** em **Por fila (roteiro)** e os tempos nos padrões.
5. Clique em **Ligar** e acompanhe **Últimas mensagens** por um ou dois dias.
6. Só depois aumente o número de chips.

## Riscos

Conversas automáticas entre chips são um padrão que o WhatsApp pode detectar. Um banimento pode atingir vários chips de uma vez, porque eles ficam no mesmo servidor.

As regras acima reduzem o risco, mas não o eliminam. Use o Maturador só com números cuja perda você aceite. Nunca ligue muitos chips de uma vez sem testar antes com dois.
