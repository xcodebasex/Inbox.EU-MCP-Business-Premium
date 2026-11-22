# Inbox.EU MCP (Business Premium)

Локальный MCP-сервер для администрирования бизнес-почты Inbox.eu. Режим `read-only` открывает 9 инструментов чтения. Режим `full` открывает все 23 операции с описанным назначением, включая удаление аккаунтов и отправку служебных писем. Фактические права определяет Inbox.eu по API-ключу. Требуется Node.js 22 или новее.

Все сетевые вызовы MCP-сервера идут по HTTPS на `https://api.inbox.eu` с проверкой сертификата. Связь Codex с дочерним процессом MCP локальная, через `stdio`.

Контрактные тесты используют [локальную копию](./inboxeu-openapi.json) версии 1.0.0, полученную 22 ноября 2026 года. Работающий сервер обращается непосредственно к API. [Исходная спецификация Inbox.eu](https://api.inbox.eu/api/v1/doc.json)

## Подключение к Codex

1. В каталоге проекта установите зависимости из lock-файла и запустите тесты. Для тестов достаточно локальных фикстур.

   ```powershell
   npm.cmd ci --ignore-scripts
   npm.cmd test
   ```

2. Создайте токен для подтверждённого домена в Inbox.eu Business и впишите его после `INBOXEU_API_KEY=` в `.env` рядом с `package.json`. Если файла ещё нет, создайте его из шаблона. Файл должен быть доступен учётной записи MCP-сервера и закрыт для посторонних пользователей и процессов песочницы. [Шаблон .env.example](./.env.example) · [Выдача токена](https://a.inbox.eu/en/api_access/)

   ```dotenv
   INBOXEU_API_KEY=
   INBOXEU_MODE=read-only
   ```

3. Добавьте секцию в `~/.codex/config.toml`. В `args` укажите абсолютный путь к серверу. Настройка `writes` включает в Codex запрос подтверждения для операций записи, включая удаление ящика и отправку сведений о нём. [Настройки MCP в Codex](https://developers.openai.com/codex/mcp/)

   ```toml
   [mcp_servers.inboxeu]
   command = "node"
   args = ["C:/Projects/InboxeuMCP/src/index.js"]
   default_tools_approval_mode = "writes"
   ```

4. В новом сеансе Codex отправьте запрос «Проверь доступ к Inbox.eu через `inboxeu_check_auth`». Действующий ключ даёт ответ `{"authenticated":true}`. Список инструментов можно посмотреть даже до добавления ключа.

В другом MCP-клиенте выберите транспорт `stdio`, команду `node` и те же аргументы запуска. Сервер читает все настройки `INBOXEU_*` из одного файла. По умолчанию это `.env` рядом с `package.json` независимо от рабочего каталога клиента. Если храните `.env` в личном каталоге, укажите его абсолютный путь после `--env-file` в `args`. Тогда сервер прочитает только выбранный файл. `.env.example` служит только шаблоном.

## Выбор режима

Установите `INBOXEU_MODE=read-only` или `INBOXEU_MODE=full` в `.env` и перезапустите MCP-сервер. В режиме чтения инструменты записи отсутствуют в каталоге, а прямой вызов по их имени отклоняется до обращения к API.

Для отдельного запуска режим можно закрепить в аргументах клиента. Например, такая настройка всегда открывает сервер в режиме чтения, даже если в `.env` выбран `full`.

```toml
args = ["C:/Projects/InboxeuMCP/src/index.js", "--env-file", "C:/Private/InboxeuMCP/.env", "--mode", "read-only"]
```

Аргумент `--mode` имеет приоритет над `INBOXEU_MODE` из выбранного файла. Если оба значения пропущены, действует `read-only`. Неизвестное значение режима или недоступный явно указанный файл останавливает запуск. Для перехода со старого `INBOXEU_ENABLE_WRITES=true` выберите `full` явно.

## Параметры инструментов в .env

Чтобы получать сведения о своём ящике без повторного ввода домена и ID, заполните две строки в загружаемом `.env` и перезапустите MCP-сервер. После этого можно вызвать `inboxeu_get_mailbox` с `{}`. В примере подставьте домен и внутренний ID своего ящика.

```dotenv
INBOXEU_DOMAIN_NAME=example.org
INBOXEU_USER_ID=00123
```

`INBOXEU_DOMAIN_NAME` задаёт домен в путях API, а также имя домена для проверки и приглашения администратора. `INBOXEU_USER_ID` задаёт ID ящика, `INBOXEU_DOMAIN_ADMIN` — ID администратора. При создании администратора поле `domainName` принимает отдельный JSON-объект. Остальные переменные сгруппированы по инструментам в [.env.example](./.env.example).

Строки, включая ID с ведущими нулями, вводите как текст. Для целых чисел и логических значений используйте запись JSON, например `20`, `true` или `false`, с учётом ограничений конкретного поля. Массивы и объекты удобно заключить в одинарные кавычки снаружи и использовать двойные кавычки внутри.

```dotenv
INBOXEU_LIST_INVOICES_LIMIT=20
INBOXEU_CREATE_ADMIN_IS_EMAIL_VERIFIED=false
INBOXEU_CREATE_ADMIN_DOMAIN_NAME='{"name":"example.org","mailboxUsernames":["office"]}'
INBOXEU_UPDATE_PROFILE_PREFS='{"itemsPerPage":50}'
INBOXEU_CREATE_MAILBOXES_BODY='[{"user":"office"}]'
```

Значение из вызова заменяет всё соответствующее поле, включая объект или массив целиком. Например, `{"limit":5}` в вызове `inboxeu_list_invoices` переопределит лимит и сохранит домен из `.env`. Пустые настройки в `.env` сервер пропускает. Изменения в файле вступают в силу после перезапуска MCP-сервера.

Сервер задаёт вопрос только об обязательном домене (`domainName`, `hostName` или `hostname`) или ID ящика (`userId`), если значение пропущено при вызове и его нельзя однозначно определить из `.env`. Если нужны оба значения, сервер сначала уточнит домен. Затем он спросит ID только в том случае, если ящик всё ещё нужно выбрать. Остальные обязательные параметры передайте при вызове или задайте в `.env`.

Если MCP-клиент поддерживает формы, он предложит ввести значение вручную и покажет подсказки из `.env`, когда они есть. При отказе или отмене формы сервер завершит вызов без обращения к Inbox.eu. Клиент без поддержки форм получит вопрос на английском. После ответа пользователя клиенту нужно повторить вызов, добавив запрошенный аргумент. Сервер проверяет итоговые аргументы до обращения к API.

Заполненные поля записи, включая пароль или адрес получателя, применяются при каждом вызове соответствующего инструмента, если вы их не переопределили. Для разовой операции передайте такие значения в самом вызове. При смене домена проверьте, что указанный ID ящика принадлежит этому домену.

### Один ключ для нескольких доменов

Если один ключ даёт доступ к нескольким доменам, запишите его один раз в `INBOXEU_API_KEY`. Для списка доменов используйте JSON-массив в `INBOXEU_DOMAINS`.

```dotenv
INBOXEU_DOMAINS='["example.org","example.net"]'
```

Чтобы сохранить ещё и ID ящиков, укажите в той же переменной JSON-объект. Для добавления домена или ящика дополните этот JSON.

```dotenv
INBOXEU_DOMAINS='{"example.org":["00123","00456"],"example.net":["00789"]}'
```

Домен по умолчанию задаёт `INBOXEU_DOMAIN_NAME`. Если эта переменная пуста и в списке ровно один домен, сервер выберет его автоматически.

При заполненном `INBOXEU_DOMAINS` сервер подбирает ящик только в выбранном домене. Для основного домена можно задать ящик по умолчанию в `INBOXEU_USER_ID`. Если у этого домена есть непустой список ID, значение `INBOXEU_USER_ID` должно входить в него. Без заданного ящика по умолчанию сервер подставит единственный ID выбранного домена.

В примере с JSON-объектом вызов `inboxeu_get_mailbox` с `{"domainName":"example.net"}` выберет ящик `00789`, даже если для основного домена `example.org` задан `INBOXEU_USER_ID=00123`. Второй ящик в `example.org` можно выбрать прямо при вызове.

```json
{"domainName":"example.org","userId":"00456"}
```

Вы можете явно указать домен и ID вне списка. При переключении между доменами сервер использует тот же ключ, а доступ к выбранному ящику проверяет Inbox.eu. Перезапуск при таком вызове не требуется.

### Токен входа и отправка сведений о ящике

Эти настройки нужны только для соответствующих инструментов в режиме `full`. В режиме `read-only` их можно оставить пустыми. Записывайте каждую переменную на отдельной строке без завершающего `\`.

При непустом `INBOXEU_DOMAINS` сервер подставляет `INBOXEU_IMPERSONATION_TOKEN` только для ящика по умолчанию. Его определяют домен по умолчанию и `INBOXEU_USER_ID` либо единственный ID в списке этого домена. Для другого ящика или при отсутствии ящика по умолчанию передайте выданный нужному ящику токен в аргументе `impersonationToken`.

| Переменная в `.env` | Что указать и где взять значение |
| --- | --- |
| `INBOXEU_IMPERSONATION_TOKEN` | Токен входа в конкретный ящик. Чтобы получить его, вызовите `inboxeu_create_impersonation_token` с доменом, внутренним ID ящика и телом `ApiMailUser`. Скопируйте значение поля `structuredContent.impersonationToken` из ответа. Для разовой проверки передайте его как аргумент `impersonationToken` того же ящика. Ключ администратора хранится отдельно в `INBOXEU_API_KEY`. |
| `INBOXEU_VALIDATE_IMPERSONATION_TOKEN_BODY` | JSON-объект `ApiMailUser` для проверки токена. В документации откройте раздел **Mailbox users** → `POST …/impersonation/validate` → **Request body**. В эту переменную запишите тело запроса. Сам токен передаётся отдельно через `INBOXEU_IMPERSONATION_TOKEN`. |
| `INBOXEU_VALIDATE_IMPERSONATION_TOKEN_IMPERSONATION_TOKEN` | Это имя MCP игнорирует. Оставьте нужный токен в одной строке `INBOXEU_IMPERSONATION_TOKEN`, затем удалите строку с длинным именем. |
| `INBOXEU_SEND_MAILBOX_DETAILS_BODY` | JSON-объект `MailUserDetails` для служебного письма со сведениями о созданном или изменённом ящике. В документации откройте **Send details for mailbox users** → `POST …/details` → **Request body**. Перед отправкой проверьте адрес получателя в подготовленном теле запроса. |

Inbox.eu публикует для обеих схем только тип «объект». Чтобы узнать точные поля, включая поле адресата для письма, возьмите тело успешного запроса к тому же методу из своей интеграции или запросите образец у `support@inbox.eu`, указав метод и название схемы. Сохраните этот JSON в одинарных кавычках в `.env` и перезапустите MCP. [Документация Inbox.eu](https://api.inbox.eu/api/v1/doc/) · [Схемы OpenAPI](https://api.inbox.eu/api/v1/doc.json)

### Mailbox sign-in tokens and account details

These settings apply to the corresponding tools in `full` mode. You can leave them empty in `read-only` mode. Put each variable on its own line without a trailing `\`.

When `INBOXEU_DOMAINS` contains entries, the server uses `INBOXEU_IMPERSONATION_TOKEN` only for the default mailbox. The default domain and either `INBOXEU_USER_ID` or that domain's sole listed mailbox ID identify this mailbox. For another mailbox, or if there is no default mailbox, pass the token issued for the target mailbox as `impersonationToken`.

| `.env` variable | What to enter and where to find it |
| --- | --- |
| `INBOXEU_IMPERSONATION_TOKEN` | The sign-in token for one mailbox. Call `inboxeu_create_impersonation_token` with the domain, internal mailbox ID, and an `ApiMailUser` body. Copy `structuredContent.impersonationToken` from the result. For a single check, pass it as the `impersonationToken` argument for the same mailbox. The administrator API key belongs in `INBOXEU_API_KEY`. |
| `INBOXEU_VALIDATE_IMPERSONATION_TOKEN_BODY` | The `ApiMailUser` JSON object for the validation request. In the API docs, open **Mailbox users** → `POST …/impersonation/validate` → **Request body**. Put the body here and supply the token separately through `INBOXEU_IMPERSONATION_TOKEN`. |
| `INBOXEU_VALIDATE_IMPERSONATION_TOKEN_IMPERSONATION_TOKEN` | The MCP server ignores this name. Keep the intended token in a single `INBOXEU_IMPERSONATION_TOKEN` entry, then remove the entry with the longer name. |
| `INBOXEU_SEND_MAILBOX_DETAILS_BODY` | The `MailUserDetails` JSON object for emailing the details of a created or updated mailbox. In the API docs, open **Send details for mailbox users** → `POST …/details` → **Request body**. Check the recipient address in the prepared request before sending. |

Inbox.eu publishes only the object type for both schemas. To get the field names, including the recipient field for the email, use the body of a successful request to the same endpoint from your integration, or ask `support@inbox.eu` for a sample and include the endpoint and schema name. Put the JSON in single quotes in `.env` and restart the MCP server. [Inbox.eu API docs](https://api.inbox.eu/api/v1/doc/) · [OpenAPI schemas](https://api.inbox.eu/api/v1/doc.json)

## Инструменты

По умолчанию доступны все девять операций чтения, описанных в OpenAPI.

| Инструмент | Вход | Результат |
| --- | --- | --- |
| `inboxeu_check_auth` | — | Проверка API-ключа |
| `inboxeu_get_profile` | — | Профиль текущего администратора |
| `inboxeu_get_2fa_status` | — | Флаг `isEnabled` для двухфакторной аутентификации |
| `inboxeu_get_admin` | `domainAdmin` | Профиль администратора по его идентификатору |
| `inboxeu_get_domain_admin` | `domainName`, `domainAdmin` | Профиль администратора указанного домена |
| `inboxeu_get_mailbox` | `domainName`, `userId` | Метаданные ящика. В панели Inbox.eu Business внутренний ID можно взять из пути `/users/<userId>/…`. Перед изменением сверьте возвращённые `id` и `user`. |
| `inboxeu_list_invoices` | `domainName`, опционально `limit`, `offset`, `unexpired`, `order_column`, `order_direction` | Страница счетов домена |
| `inboxeu_check_domain` | `hostName` | `available` показывает, свободно ли имя в базе Inbox.eu |
| `inboxeu_check_admin_email` | `email` | `available` показывает, можно ли использовать email для администратора |

Например, для первой страницы счетов передайте `{"domainName":"example.org","limit":20,"offset":0}`. Для следующей страницы увеличьте `offset` на число полученных записей. Сумма сохраняет исходное строковое представление и сопровождается валютой, если API её вернул.

### Дополнительные инструменты режима full

| Инструмент | Вход |
| --- | --- |
| `inboxeu_create_admin` | Обязательные `email` и `language`. Опционально `firstName`, `lastName`, `password`, `euRefId`, `isEmailVerified` и объект `domainName` с `name` и/или `mailboxUsernames`. Если пароль опущен, Inbox.eu отправит сгенерированный пароль по email. Для `isEmailVerified` требуются специальные права. |
| `inboxeu_update_profile` | Хотя бы одно из полей `firstName`, `lastName`, `language`, `prefs`, `plainPassword`, `tos`. В настройках доступны `itemsPerPage`, `userSortField`, `userSortOrder`. |
| `inboxeu_invite_admin` | `email`, `user`, `hostname`. Inbox.eu отправит приглашение администратору. |
| `inboxeu_delete_profile` | Без параметров. Удаляет аккаунт администратора, которому принадлежит API-ключ. |
| `inboxeu_remove_domain_admin` | `domainName`, `domainAdmin`. Отзывает доступ администратора к одному домену. |
| `inboxeu_enable_2fa`, `inboxeu_disable_2fa` | Без параметров. Меняют настройку текущего администратора. При включении MCP возвращает полученные от API данные для регистрации в приложении-аутентификаторе. |
| `inboxeu_create_mailboxes` | `domainName`, `body` — массив объектов `ApiMailUser`. В `summary.succeeded` и `summary.failed` указано, сколько ящиков создано и сколько запросов отклонено. Для отклонённой записи поле `message` поясняет причину, в том числе достижение лимита ящиков, если Inbox.eu сообщил об этом. |
| `inboxeu_update_mailbox` | `domainName`, `userId`, `body` — объект `ApiMailUser`. Для изменения имени и фамилии ящика Inbox.eu принимает поля `forename` и `surname`. |
| `inboxeu_delete_mailbox` | `domainName`, `userId`. Удаляет указанный ящик. |
| `inboxeu_send_mailbox_details` | `domainName`, `userId`, `body` — объект `MailUserDetails`. Запрашивает у Inbox.eu отправку письма со сведениями о ящике. |
| `inboxeu_update_mailbox_filters` | `domainName`, `userId`. Документация описывает PUT-запрос только с этими параметрами. |
| `inboxeu_create_impersonation_token` | `domainName`, `userId`, `body` — объект `ApiMailUser`. Возвращает полученный токен для входа в указанный ящик. |
| `inboxeu_validate_impersonation_token` | Те же параметры и строка `impersonationToken`. Если действительность токена определить не удалось, сервер возвращает `valid: null` и пояснение в поле `message`. |

Типы и допустимые значения доступны через `tools/list`. Для `ApiMailUser` и `MailUserDetails` провайдер публикует тип «объект» без списка полей. MCP передаёт предоставленный JSON в теле соответствующего запроса. Для изменения фильтров схема тела не опубликована. Семь дополнительных записей для `/domain_admins/{domainAdmin}` содержат только пустой ответ `default` без описания назначения и результата. [Контракт Inbox.eu](https://api.inbox.eu/api/v1/doc.json)

### Какие письма можно отправить

HTTPS API поддерживает приглашение администратора и отправку сведений о созданном или изменённом ящике. Отправка обычного письма с произвольными адресатами, темой и текстом в опубликованном HTTPS API v1 отсутствует. [Документация Inbox.eu](https://api.inbox.eu/api/v1/doc/)

## Ответы и диагностика

- Сервер отправляет ключ в заголовке `Authorization: Bearer`. Адрес API фиксирован. Переадресация отключена, в том числе на HTTP. При отключённой в Node.js проверке TLS-сертификатов сервер отклоняет запрос до отправки.
- При сбое вызова MCP возвращает `isError: true` и короткое пояснение на английском. Если сервис отклонил ключ, проверьте `INBOXEU_API_KEY`. Если для операции недостаточно прав, проверьте доступ администратора к домену. При ограничении частоты запросов повторите попытку позже.
- При проверке домена и адреса администратора поле `available` показывает, свободно ли имя. Если сервис отклонил проверку адреса, инструмент вернёт ошибку. [Описание методов](https://api.inbox.eu/api/v1/doc/)
- При чтении профилей, счетов и статуса двухфакторной аутентификации сервер исключает ключи, пароли и секреты. Данные настройки двухфакторной аутентификации и токен входа возвращаются клиенту при явном вызове соответствующего инструмента в режиме `full`.
- Один вызов отправляет один запрос. Тайм-аут — 15 секунд, предел тела ответа — 1 МиБ. Если соединение оборвалось после отправки записи, проверьте её результат в панели Inbox.eu перед ручным повтором. Для большого списка счетов уменьшите `limit`.
- Результат операции доступен в `structuredContent`. Для отказа или неподтверждённого изменения текстовый блок `content` содержит короткое пояснение, для частично выполненного пакета — сводку. Результаты отдельных ящиков остаются в `structuredContent.data`.
