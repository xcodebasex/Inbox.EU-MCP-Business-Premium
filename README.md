# Inbox.EU MCP (Business Premium)

[Russian-language guide](./README.ru.md)

Use this local Model Context Protocol (MCP) server to manage Inbox.eu Business Premium domains and mailboxes. It starts in `read-only` mode with eleven tools for checking access and looking up administrators, mailboxes, and invoices. Switch to `full` to enable all 25 tools, including mailbox updates, account deletion, and email invitations. Your Inbox.eu API key determines which operations the service allows.

The server requires **Node.js 22 or later**. Your MCP client starts it as a local process and communicates over `stdio`. The server sends API requests over HTTPS to `https://api.inbox.eu` and verifies the TLS certificate.

The contract tests use version 1.0.0 of the Inbox.eu API specification, saved on November 22, 2026. At runtime, the server calls the live API. [Bundled OpenAPI specification](./inboxeu-openapi.json) · [Upstream specification](https://api.inbox.eu/api/v1/doc.json)

## Install and run locally

1. Install Node.js 22 or later with npm. Clone the repository and open its directory. You can also download the ZIP from GitHub, extract it, and open a terminal in the folder containing `package.json`.

   ```sh
   git clone https://github.com/xcodebasex/Inbox.EU-MCP-Business-Premium.git
   cd Inbox.EU-MCP-Business-Premium
   ```

2. Check your Node.js version, install the dependencies, and run the tests. The tests use local fixtures and can run without an API key.

   ```sh
   node --version
   npm ci --ignore-scripts
   npm test
   ```

   In Windows PowerShell, you can use `npm.cmd` for both commands.

3. Create `.env` beside `package.json`. Use the command for your system. Both commands preserve an existing configuration.

   **Windows PowerShell**

   ```powershell
   if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
   ```

   **macOS or Linux**

   ```sh
   [ -e .env ] || cp .env.example .env
   ```

   Open `.env` in a text editor. Enter your Inbox.eu Business API key after `INBOXEU_API_KEY=` and keep `read-only` for your first run. Restrict file access to the account running the server. [Configuration template](./.env.example) · [Get an Inbox.eu API key](https://a.inbox.eu/en/api_access/)

   ```dotenv
   INBOXEU_API_KEY=
   INBOXEU_MODE=read-only
   ```

   A configured API key can look up a mailbox by its full address. [Look up a mailbox by email address](#look-up-a-mailbox-by-email-address)

4. Start the server from the project directory.

   ```sh
   node src/index.js
   ```

   A quiet terminal is expected. The server waits for MCP messages on standard input and writes protocol responses to standard output. Press **Ctrl+C** to stop the manual run.

## Install the plugin in ChatGPT Desktop

This setup is for local chats in the desktop app’s **Work** mode. After installing the dependencies and configuring `.env` as described above, run this command from the folder containing `package.json`.

```sh
npm run plugin:desktop
```

In Windows PowerShell, you can use `npm.cmd run plugin:desktop`.

1. Restart ChatGPT Desktop and open the project folder in **Work** mode.
2. Open **Plugins**, choose **Inbox.eu Local** from the marketplace selector, and install **Inbox.eu Business**. [OpenAI’s local marketplace guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)
3. In a new local **Work** chat in the project, type `@Inbox.eu` and select **Inbox.eu Business** under **Plugins**. Ask “Call `inboxeu_check_auth` with `{}`.” A valid key returns `{"authenticated":true}`. To check the installation before adding a key, ask for the list of Inbox.eu tools. The default `read-only` mode exposes eleven. [Selecting a plugin in Work](https://learn.chatgpt.com/docs/build-plugins#using-a-plugin)

The plugin runs `node` from your system PATH and launches the existing `src/index.js`. The server reads the original `.env` beside `package.json`. Tool results returned to ChatGPT can include mailbox data. If you move the project, rerun the preparation command from its new folder and reinstall the plugin. If ChatGPT cannot find Node.js, add it to your PATH and restart the desktop app.

### Update an existing desktop installation

Run these commands in the directory you cloned from GitHub.

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run plugin:desktop
```

If you use an existing ChatGPT connection through a Secure MCP Tunnel, restart the tunnel client that launches this server. In the plugin settings in ChatGPT, select **Refresh tools**. Confirm that `inboxeu_list_mailboxes` appears in the read tools.

If you installed from a ZIP, extract the new version, place your existing `.env` beside its `package.json`, and run the two npm commands above in that folder.

Fully quit ChatGPT Desktop, reopen the updated project in **Work**, and reinstall **Inbox.eu Business** from **Inbox.eu Local**. This replaces the older server process, which could keep using an empty key even in a new chat. The preparation command writes the machine-specific `plugins/inboxeu-business/mcp.json`. Your key stays in the project's `.env`.

Select the plugin with `@` and call `inboxeu_check_auth` with `{}`. Expect `{"authenticated":true}`. If the tool reports `Set INBOXEU_API_KEY to a key with no spaces or line breaks.`, check the `INBOXEU_API_KEY` entry in that project's `.env`. With the updated server, saving, replacing, or clearing just the key takes effect on the next call in the same chat. Changes to the access mode or tool defaults require a server restart.

## Connect an MCP client and check access

In a client that supports local MCP servers, add a server named `inboxeu`, choose the `stdio` transport, set the command to `node`, and pass the **absolute path to `src/index.js`** as the first argument. The client starts its own server process. If the client uses an `mcpServers` JSON configuration, use this example and replace the path with your actual installation path.

```json
{
  "mcpServers": {
    "inboxeu": {
      "command": "node",
      "args": ["/absolute/path/to/Inbox.EU-MCP-Business-Premium/src/index.js"]
    }
  }
}
```

On Windows, a path such as `C:/Projects/Inbox.EU-MCP-Business-Premium/src/index.js` works. If your client cannot find `node`, use the absolute path to the executable. You can find it with `(Get-Command node).Source` in PowerShell or `command -v node` on macOS and Linux.

Restart the connection and open the client's tool list (`tools/list`). In `read-only` mode you should see eleven tools, even before adding a key. To verify the key itself, call `inboxeu_check_auth` with `{}`. A valid key returns `{"authenticated":true}`.

All `INBOXEU_*` settings come from one file. The default is `.env` beside `package.json`, regardless of the client's working directory. To keep it elsewhere, pass the absolute path with `--env-file`.

If the key is missing or has changed, save the new `INBOXEU_API_KEY` in that file and call `inboxeu_check_auth` again in the same chat. The server reads the key for each API request. Restart the MCP server after changing other settings, including the access mode, domain or mailbox defaults.

## Choose an access mode

Set `INBOXEU_MODE` in `.env` and restart the server after a change.

| Mode | Tools available |
| --- | --- |
| `read-only` (default) | Eleven read tools. The server rejects a direct call to a write tool before contacting Inbox.eu. |
| `full` | All 25 tools. Write operations still require the corresponding permissions in Inbox.eu. |

To pin a launch to read-only mode and select a private configuration file, run the following command from the project directory, using the path to your file. In a client configuration, append the same options and values to the arguments array as separate strings.

```sh
node src/index.js --env-file "/absolute/path/to/private/.env" --mode read-only
```

`--mode` takes precedence over `INBOXEU_MODE`. The server stops at startup if the mode is unknown or an explicitly selected file cannot be read. If you previously used `INBOXEU_ENABLE_WRITES=true`, select `full` explicitly to enable writes.

## Look up a mailbox by email address

Set `INBOXEU_API_KEY` in the local `.env` beside `package.json` and start the server in `read-only` mode. In ChatGPT, select **Inbox.eu Business** and ask “What is the account status of info@example.org?” Replace the sample address with an address on a domain your administrator key can read. In another MCP client, call `inboxeu_get_mailbox` with these arguments.

```json
{"mailboxEmail":"info@example.org"}
```

The server takes the domain from the address, reads its mailbox directory over HTTPS, and finds the matching internal ID. It then fetches the account and verifies the identity before returning `data.email` and `data.id`. If the directory contains no matching address, the tool reports that outcome. An API access error leaves the mailbox status unconfirmed. Discovery happens on demand within that domain. The server does not save the discovered directory to disk.

To see which domains the key can manage, ask “List my Inbox.eu domains”, or call `inboxeu_list_domains` with `{}`. Its `domains` array contains just the domain names.

To list the addresses and IDs in a domain, ask “List the mailboxes and user IDs in example.org”, or call `inboxeu_list_mailboxes` with `{"domainName":"example.org"}`. Each item in `data` contains `email`, `userId` as a string, and `status` when supplied by Inbox.eu. Results include `total`, `offset`, and `nextOffset`. To request another page, pass the returned `nextOffset` as `offset`. The default page size is 100 and the `limit` range is 1–100. Set `INBOXEU_DOMAIN_NAME=example.org` in `.env` to make the domain optional when listing. With no domain settings, the server can discover the authorized domains. It selects a sole domain and asks you to choose when several are available. If you request a mailbox using only its domain, it uses an applicable local mailbox selection first. Otherwise it reads the mailbox directory, selects a sole entry, or asks which address and ID you want. An empty directory yields an empty-list message.

**Using a known ID.** If your key can read an individual account but the domain directory is unavailable, pass both values, for example `{"mailboxEmail":"info@example.org","userId":"00123"}`. You can also keep selected IDs in `INBOXEU_DOMAINS`. Under each domain, map the part before `@` to the ID from the account’s edit link in the Business control panel (`/users/<ID>/edit`). Keep IDs in quotes to preserve leading zeros.

```dotenv
INBOXEU_DOMAINS='{"example.org":{"info":"00123","sales":"00456"},"example.net":{"office":"00789"}}'
```

An explicit or configured ID skips directory discovery. The same address check applies to the returned account. Restart the server after editing `INBOXEU_DOMAINS`. Older clients can pass the full address in `userId` for this read tool.

## Setting tool arguments in `.env`

To choose a default mailbox for calls with no arguments, set these two optional variables in `.env`. Replace the sample values with your domain and internal mailbox ID, then restart the MCP server. You can now call `inboxeu_get_mailbox` with `{}`.

```dotenv
INBOXEU_DOMAIN_NAME=example.org
INBOXEU_USER_ID=00123
```

`INBOXEU_DOMAIN_NAME` sets the domain used in API paths, domain checks, and administrator invitations. `INBOXEU_USER_ID` sets the mailbox ID, and `INBOXEU_DOMAIN_ADMIN` sets the administrator ID. When you create an administrator, the `domainName` field takes a separate JSON object. The remaining variables are grouped by tool in [.env.example](./.env.example).

Enter strings as plain text to preserve values such as mailbox IDs with leading zeros. Use JSON syntax for integers and booleans, such as `20`, `true`, or `false`, and choose values within the limits of each field. For arrays and objects, use double quotes inside the JSON and wrap the whole value in single quotes.

```dotenv
INBOXEU_LIST_INVOICES_LIMIT=20
INBOXEU_CREATE_ADMIN_IS_EMAIL_VERIFIED=false
INBOXEU_CREATE_ADMIN_DOMAIN_NAME='{"name":"example.org","mailboxUsernames":["office"]}'
INBOXEU_UPDATE_PROFILE_PREFS='{"itemsPerPage":50}'
INBOXEU_CREATE_MAILBOXES_BODY='[{"user":"office"}]'
```

A tool argument overrides the entire corresponding field, including a whole object or array. For example, calling `inboxeu_list_invoices` with `{"limit":5}` overrides the limit and keeps the domain from `.env`. The server skips empty settings in `.env`. Restart the MCP server after editing these argument defaults.

For reads on an existing domain, the server uses an explicit domain or the configured selection first. If no domains are configured, it can retrieve the domain list using your API key. When several candidates remain, it asks which domain to use. A domain availability check can target any hostname, so supply the hostname or answer the prompt. For a write operation, supply the target or configure it in `.env`. The server asks for any domain or mailbox ID it still needs.

If your MCP client supports forms, it prompts you to enter the value and shows suggestions from `.env` when available. If you decline or cancel the form, the server ends the call without contacting Inbox.eu. A client without form support receives a question in English. After you answer, the client needs to repeat the call with the requested argument. The server validates the resulting arguments before contacting the API.

Values you set for write operations, including passwords and recipient addresses, apply to every call to the corresponding tool unless you override them. For a one-time operation, pass those values in the call itself. When switching domains, check that the mailbox ID belongs to the selected domain.

### Using one API key for multiple domains

If one API key gives you access to several domains, enter it once in `INBOXEU_API_KEY`. To list the domains, use a JSON array in `INBOXEU_DOMAINS`.

```dotenv
INBOXEU_DOMAINS='["example.org","example.net"]'
```

To store internal IDs by domain, you can also use arrays of IDs. For queries by email address, the server can discover mailbox IDs from Inbox.eu. [Look up a mailbox by email address](#look-up-a-mailbox-by-email-address)

```dotenv
INBOXEU_DOMAINS='{"example.org":["00123","00456"],"example.net":["00789"]}'
```

`INBOXEU_DOMAIN_NAME` sets the default domain. If it is empty and exactly one domain is listed, the server selects that domain automatically.

When `INBOXEU_DOMAINS` contains entries, the server looks up mailbox IDs only within the selected domain. You can set the default mailbox for the default domain in `INBOXEU_USER_ID`. If that domain has a nonempty list of IDs, the list must include `INBOXEU_USER_ID`. If no default mailbox is set and the selected domain has exactly one listed ID, the server uses that ID.

In the JSON object example above, calling `inboxeu_get_mailbox` with `{"domainName":"example.net"}` selects mailbox `00789`, even if `INBOXEU_USER_ID=00123` is set for the default domain, `example.org`. To select the second mailbox in `example.org`, pass its ID in the call.

```json
{"domainName":"example.org","userId":"00456"}
```

You can also explicitly pass a domain and mailbox ID outside the list. The server uses the same API key when switching domains, and Inbox.eu checks access to the selected mailbox. You can make this call without restarting the server.

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

## Tools

The eleven read tools call the Inbox.eu Business administration API over HTTPS. The provider describes domain and mailbox listing in its Business API overview. The live API serves the domain list at `GET /api/v1/domains/` and the paged mailbox list at `GET /api/v1/domains/{domainName}/mail_users/`. The published OpenAPI file currently omits these routes. [Inbox.eu Business API overview](https://www.inbox.eu/en/inbox-eu-api/) A successful mailbox lookup confirms that Inbox.eu returned the account. Reading folders or messages and testing mail delivery are outside the scope of this API. [Inbox.eu OpenAPI specification](https://api.inbox.eu/api/v1/doc.json)

| Tool | Arguments | Result |
| --- | --- | --- |
| `inboxeu_check_auth` | None | Checks whether the API key authenticates successfully. |
| `inboxeu_get_profile` | None | Returns the current administrator's profile. |
| `inboxeu_get_2fa_status` | None | Returns the `isEnabled` flag for two-factor authentication. |
| `inboxeu_get_admin` | `domainAdmin` | Returns an administrator's profile by ID. If Inbox.eu denies the global lookup, the tool checks the configured default or sole domain. Without a default domain it checks the current profile. Either fallback must return the requested ID. |
| `inboxeu_get_domain_admin` | `domainName`, `domainAdmin` | Returns the administrator's profile for the specified domain. |
| `inboxeu_list_domains` | None | Returns the names of domains the API key can access in `domains`. |
| `inboxeu_list_mailboxes` | `domainName`, optional `limit` and `offset` | Lists mailbox addresses and internal IDs in the selected domain, with pagination. |
| `inboxeu_get_mailbox` | `mailboxEmail`, or `domainName` and `userId` | Returns administrative details for one mailbox. An address lookup discovers the internal ID when needed and verifies the identity in the response. |
| `inboxeu_list_invoices` | `domainName` and optional `limit`, `offset`, `unexpired`, `order_column`, `order_direction` | Returns one page of invoices for the domain. |
| `inboxeu_check_domain` | `hostName` | `available` indicates whether the domain name is available in the Inbox.eu database. |
| `inboxeu_check_admin_email` | `email` | Checks whether an address is available for **administrator registration**. To check a mailbox account, use `inboxeu_get_mailbox`. |

To request the first page of invoices, pass `{"domainName":"example.org","limit":20,"offset":0}`. For the next page, increase `offset` by the number of records returned. Each invoice amount retains its original string representation and includes the currency when the API supplies it.

### Additional tools in full mode

| Tool | Arguments and behavior |
| --- | --- |
| `inboxeu_create_admin` | Requires `email` and `language`. Optional fields are `firstName`, `lastName`, `password`, `euRefId`, `isEmailVerified`, and a `domainName` object containing `name`, `mailboxUsernames`, or both. If you omit `password`, Inbox.eu emails a generated password. Setting `isEmailVerified` requires special permissions. |
| `inboxeu_update_profile` | Supply at least one of `firstName`, `lastName`, `language`, `prefs`, `plainPassword`, or `tos`. The `prefs` object supports `itemsPerPage`, `userSortField`, and `userSortOrder`. |
| `inboxeu_invite_admin` | `email`, `user`, `hostname`. Inbox.eu emails an invitation to the administrator. |
| `inboxeu_delete_profile` | Takes no arguments. Deletes the administrator account that owns the API key. |
| `inboxeu_remove_domain_admin` | `domainName`, `domainAdmin`. Revokes the administrator's access to that domain. |
| `inboxeu_enable_2fa`, `inboxeu_disable_2fa` | Both take no arguments and change two-factor authentication for the current administrator. When you enable it, the server returns the enrollment data supplied by Inbox.eu for use in an authenticator app. |
| `inboxeu_create_mailboxes` | `domainName` and a `body` array of `ApiMailUser` objects. `summary.succeeded` counts created mailboxes and `summary.failed` counts rejected entries. Each rejected entry includes a `message` with the reason, including a mailbox limit when Inbox.eu reports one. |
| `inboxeu_update_mailbox` | `domainName`, `userId`, and an `ApiMailUser` object as `body`. Use `forename` and `surname` to change the mailbox user's first and last names. |
| `inboxeu_delete_mailbox` | `domainName`, `userId`. Deletes the specified mailbox. |
| `inboxeu_send_mailbox_details` | `domainName`, `userId`, and a `MailUserDetails` object as `body`. Asks Inbox.eu to email the mailbox details. |
| `inboxeu_update_mailbox_filters` | `domainName`, `userId`. These are the only parameters documented for the PUT request. |
| `inboxeu_create_impersonation_token` | `domainName`, `userId`, and an `ApiMailUser` object as `body`. Returns a sign-in token for the specified mailbox. |
| `inboxeu_validate_impersonation_token` | `domainName`, `userId`, an `ApiMailUser` object as `body`, and the `impersonationToken` string. If the server cannot determine whether the token is valid, it returns `valid: null` and an explanation in `message`. |

Use `tools/list` to inspect argument types and allowed values. Inbox.eu defines `ApiMailUser` and `MailUserDetails` as objects and leaves their fields unspecified. The MCP server sends the supplied JSON as the request body. The mailbox filter update has no published body schema. Seven additional entries for `/domain_admins/{domainAdmin}` contain only an empty `default` response and give no description of their purpose or result. [Inbox.eu OpenAPI specification](https://api.inbox.eu/api/v1/doc.json)

### Which emails can I send?

You can ask Inbox.eu to email an administrator invitation or send account details for a newly created or updated mailbox. Inbox.eu also emails a generated password when you create an administrator and omit `password`. Sending ordinary messages with your own recipient, subject, and body requires a separate mail integration. [Inbox.eu API documentation](https://api.inbox.eu/api/v1/doc/)

## Responses and troubleshooting

- The server sends the key in the `Authorization: Bearer` header to a fixed API address. It blocks all redirects, including redirects to HTTP. If TLS certificate verification is disabled in Node.js, the server rejects the request before sending it.
- When a tool call fails, the server returns `isError: true` and a short explanation in English. For example, an authentication error reads `Inbox.eu did not accept the API key for this operation.` Check `INBOXEU_API_KEY` if you see that message. If the operation requires more permissions, check the administrator's access to the domain. If you hit a rate limit, try again later.
- For administrator email checks, an explicit reply from Inbox.eu that an address is available for registration returns `available: true`. An unrecognized error remains an error. A domain check reports only whether the domain name is available in Inbox.eu. [Inbox.eu API documentation](https://api.inbox.eu/api/v1/doc/)
- When reading profiles, invoices, and two-factor authentication status, the server filters out keys, passwords, and secrets. To retrieve authenticator enrollment data or a mailbox sign-in token, explicitly call the corresponding tool in `full` mode.
- Each API request has a 15-second timeout and a maximum response body size of 1 MiB. If the connection drops after a write request is sent, check the result in the Inbox.eu control panel before retrying. For large invoice lists, reduce `limit`.
- The operation result is available in `structuredContent`. The `content` text block gives a short explanation when an operation is rejected or a change is unconfirmed. For a partially completed batch, it gives a summary. Individual mailbox results are available in `structuredContent.data`.
