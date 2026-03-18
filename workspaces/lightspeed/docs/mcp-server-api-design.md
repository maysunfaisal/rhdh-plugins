# MCP Server Management — Backend API Design

> **Plugin**: `@red-hat-developer-hub/backstage-plugin-lightspeed-backend`
> **Date**: 2026-03-02
> **Status**: Draft

---

## 1. Overview

The Lightspeed backend currently reads MCP server credentials from static `app-config.yaml` and forwards them as `MCP-HEADERS` to the Lightspeed Core Service (LCS). This design adds **dynamic MCP server management** — a set of REST APIs that let users add, update, validate, and remove MCP server connections through the UI, with persistent storage that works identically on local laptops and OpenShift.

### Goals

- Users can add an MCP server by providing a **name**, **URL**, and **token** through the frontend.
- The backend **validates credentials** against the MCP server before accepting them (like Cursor's MCP settings).
- The frontend can **list all configured MCP servers** showing name, connection status, and tool count.
- Users can **update a Personal Access Token** for any configured server.
- The solution works on **both local development and OpenShift/RHDH** with zero platform-specific code.
- **Backward compatible** — existing `app-config.yaml` MCP servers continue to work.

---

## 2. Architecture Decisions

### 2.1 Storage: Backstage Database Service

**Decision**: Use Backstage's built-in `coreServices.database` (Knex).

**Why not other approaches?**

| Approach                             | Local                       | OpenShift                                             | Verdict                                          |
| ------------------------------------ | --------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| Config file (à la Cursor `mcp.json`) | Works                       | Fails — container filesystems are ephemeral/read-only | Not viable for production                        |
| Kubernetes Secrets                   | Not available               | Works                                                 | Two different implementations — fragile          |
| **Backstage Database Service**       | **SQLite (better-sqlite3)** | **PostgreSQL**                                        | **Single implementation, zero new dependencies** |

**How it works**: Backstage already ships with a database abstraction (`coreServices.database`). Every Backstage plugin can request a Knex client scoped to its own database/schema. The `backend.database` block in `app-config.yaml` determines which engine is used — the plugin code never changes.

**Local development** (already configured in `app-config.yaml`):

```yaml
backend:
  database:
    client: better-sqlite3
    connection: ':memory:' # in-memory, resets on restart
    # connection: './lightspeed.db'   # file-based, persistent across restarts
```

`better-sqlite3` is bundled with Backstage — no install needed.

**OpenShift / RHDH**: RHDH always ships with a PostgreSQL instance. The Helm chart or Operator configures:

```yaml
backend:
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
```

This is already present in every RHDH deployment. The lightspeed plugin simply calls `database.getClient()` and receives a Knex client pointing at the correct engine. Schema migrations run automatically on startup.

**No new external dependency** — this is a built-in Backstage capability already used by the catalog, search, and other core plugins, as well as sibling RHDH plugins (e.g., `adoption-insights`).

### 2.2 Platform Detection (Not Required)

Because the database abstraction handles the local-vs-OpenShift difference transparently, there is **no need to detect the runtime platform**. The same code runs everywhere. (For reference, if needed in the future, Kubernetes injects `KUBERNETES_SERVICE_HOST` into every pod — `process.env.KUBERNETES_SERVICE_HOST` is truthy on OpenShift and undefined locally.)

### 2.3 Dual Source Model + Per-User Scoping

MCP servers come from two sources, merged at query time:

```
┌──────────────────────────┐    ┌──────────────────────────┐
│   Static Config          │    │   Dynamic (Database)     │
│   (app-config.yaml)      │    │   (managed via API)      │
│                          │    │                          │
│ - Read-only              │    │ - Full CRUD              │
│ - Managed by admins      │    │ - Per-user (scoped by    │
│ - Shared across users    │    │   created_by)            │
│ - No URL (LCS resolves)  │    │ - Has URL for validation │
│ - source: "static"       │    │ - source: "dynamic"      │
└──────────────────────────┘    └──────────────────────────┘
            │                               │
            └───────────┬───────────────────┘
                        ▼
              Merged MCP-HEADERS
              sent to LCS on /v1/query
              (static shared + this user's dynamic)
```

**Static config servers** are shared — visible to everyone, not editable via the API.

**Dynamic servers are per-user.** Each user manages their own MCP servers with their own PATs. When `GET /mcp-servers` is called, the backend returns:

- All static config servers (shared)
- Only the requesting user's dynamic servers (filtered by `created_by`)

This means:

- User A adds "GitHub" with their PAT → only User A sees it
- User B adds "GitHub" with a different PAT → only User B sees it
- Both users see the same static config servers

When building `MCP-HEADERS` for `/v1/query`, the backend merges static config tokens (shared) with only the **requesting user's** dynamic tokens. This ensures each user's chat uses their own credentials.

**`createdBy` value by auth provider:**

| Scenario                   | `createdBy` value                   | Notes                                                     |
| -------------------------- | ----------------------------------- | --------------------------------------------------------- |
| GitHub SSO on RHDH         | `user:default/maysun`               | Resolved from GitHub username                             |
| Guest provider (local dev) | `user:default/guest`                | All guest sessions share the same identity                |
| Postman (no auth)          | Request rejected (401)              | `httpAuth.credentials()` requires a valid Backstage token |
| Postman (with token)       | Whichever user the token belongs to | Must obtain a token from Backstage auth first             |

> **Local dev caveat**: With guest auth, all local sessions resolve to `user:default/guest`, so all "guest" users share the same MCP server list. This is expected for local development. On RHDH with SSO, each user gets proper isolation.

---

## 3. Data Model

### 3.1 Database Table: `lightspeed_mcp_servers`

| Column       | Type      | Constraints       | Description                                   |
| ------------ | --------- | ----------------- | --------------------------------------------- |
| `id`         | TEXT      | PRIMARY KEY       | UUID, auto-generated                          |
| `name`       | TEXT      | NOT NULL          | Display name (e.g., "GitHub")                 |
| `url`        | TEXT      | NOT NULL          | MCP server endpoint URL                       |
| `token`      | TEXT      | NOT NULL          | Bearer token / PAT                            |
| `status`     | TEXT      | DEFAULT 'unknown' | `connected`, `error`, `unknown`               |
| `enabled`    | BOOLEAN   | DEFAULT true      | Whether the server is active for chat queries |
| `tool_count` | INTEGER   | DEFAULT 0         | Number of tools discovered                    |
| `created_by` | TEXT      | NOT NULL          | Backstage user entity ref                     |
| `created_at` | TIMESTAMP | DEFAULT NOW       | Creation time                                 |
| `updated_at` | TIMESTAMP | DEFAULT NOW       | Last modification time                        |

**Composite unique constraint**: `UNIQUE(name, created_by)` — each user can have at most one server with a given name, but different users can each add a server named "GitHub" with their own PAT.

**All queries are scoped by `created_by`** — the store never returns another user's servers.

### 3.2 API Response Types

```typescript
// Returned in list and detail responses (token is NEVER exposed)
interface McpServerResponse {
  id: string;
  name: string;
  url: string;
  status: 'connected' | 'error' | 'unknown';
  enabled: boolean;
  toolCount: number;
  source: 'static' | 'dynamic';
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// Returned from validation endpoints
interface McpValidationResult {
  valid: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}
```

> **Security**: The `token` field is **never returned** in any API response. The frontend only sends tokens in create/update requests.

---

## 4. REST API Endpoints

All endpoints are mounted under `/api/lightspeed/` (Backstage convention).

### 4.1 List MCP Servers

```
GET /api/lightspeed/mcp-servers
```

**Permission**: `lightspeed.mcp.read`

**Behavior**: Returns static config servers (shared) plus the authenticated user's dynamic servers. The frontend does **not** need to filter — the backend already scopes the response to the requesting user.

**Response** `200 OK`:

```json
{
  "servers": [
    {
      "id": "static-mcp-integration-tools",
      "name": "mcp-integration-tools",
      "url": "",
      "status": "unknown",
      "toolCount": 0,
      "source": "static",
      "updatedAt": null
    },
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "GitHub",
      "url": "https://api.githubcopilot.com/mcp/",
      "status": "connected",
      "toolCount": 12,
      "source": "dynamic",
      "createdBy": "user:default/maysun",
      "createdAt": "2026-03-02T10:00:00Z",
      "updatedAt": "2026-03-02T10:30:00Z"
    }
  ]
}
```

### 4.2 Add MCP Server

```
POST /api/lightspeed/mcp-servers
```

**Permission**: `lightspeed.mcp.manage`

**Request Body**:

```json
{
  "name": "GitHub",
  "url": "https://api.githubcopilot.com/mcp/",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

**Behavior**: Creates the server record, validates credentials, and registers with LCS. The server is saved regardless of validation outcome (status will be `connected` or `error`). This allows users to fix tokens later without re-entering all details.

**Response** `201 Created`:

```json
{
  "server": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "GitHub",
    "url": "https://api.githubcopilot.com/mcp/",
    "status": "connected",
    "toolCount": 12,
    "source": "dynamic",
    "createdBy": "user:default/maysun",
    "createdAt": "2026-03-02T10:00:00Z",
    "updatedAt": "2026-03-02T10:00:00Z"
  },
  "validation": {
    "valid": true,
    "toolCount": 12,
    "tools": [
      { "name": "create_issue", "description": "Create a GitHub issue" },
      { "name": "list_repos", "description": "List repositories" }
    ]
  },
  "lcsRegistered": true
}
```

**Error** `409 Conflict` (name already exists):

```json
{ "error": "MCP server with name 'GitHub' already exists" }
```

### 4.3 Update MCP Server Token

```
PATCH /api/lightspeed/mcp-servers/:id
```

**Permission**: `lightspeed.mcp.manage`

**Request Body** (all fields optional):

```json
{
  "token": "ghp_new_token_value",
  "name": "GitHub Enterprise",
  "url": "https://mcp.github.example.com/",
  "enabled": false
}
```

**Behavior**: Updates the provided fields. Re-validates credentials only when `token` or `url` changes (not on `enabled` toggle — that's instant). When `enabled` is `false`, the server is excluded from `MCP-HEADERS` at query time.

**Response** `200 OK`:

```json
{
  "server": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "GitHub Enterprise",
    "url": "https://mcp.github.example.com/",
    "status": "connected",
    "toolCount": 12,
    "source": "dynamic",
    "updatedAt": "2026-03-02T11:00:00Z"
  },
  "validation": {
    "valid": true,
    "toolCount": 12,
    "tools": [...]
  }
}
```

**Error** `404 Not Found`:

```json
{ "error": "MCP server not found" }
```

**Error** `400 Bad Request` (trying to edit a static server):

```json
{ "error": "Cannot modify a static configuration server" }
```

### 4.4 Delete MCP Server

```
DELETE /api/lightspeed/mcp-servers/:id
```

**Permission**: `lightspeed.mcp.manage`

**Response** `204 No Content`

**Error** `400 Bad Request` (static server):

```json
{ "error": "Cannot delete a static configuration server" }
```

### 4.5 Validate Existing MCP Server (On-Demand Refresh)

```
POST /api/lightspeed/mcp-servers/:id/validate
```

**Permission**: `lightspeed.mcp.read`

**Behavior**: Validates an existing MCP server using its stored credentials. Works for **both static and dynamic** servers:

- **Dynamic servers** (`id` is a UUID): Looks up the URL and token from the database, runs the MCP protocol handshake (`initialize` → `initialized` → `tools/list`), and **updates the server's `status` and `tool_count` in the database**.
- **Static servers** (`id` starts with `static-`): Looks up the URL and token from `app-config.yaml` (resolved at startup), runs the same handshake, and returns the result. No database update (static servers aren't stored in the DB).

**Frontend usage**: The frontend calls `GET /mcp-servers` first for an instant render, then fires `POST /mcp-servers/:id/validate` for each server in parallel. As each response arrives, the UI updates the status icon and tool count for that row. This avoids blocking the list load while still providing live status.

**Response** `200 OK`:

```json
{
  "id": "6fea5076-e857-4408-80d5-8a38d0f81c98",
  "name": "mcp-integration-tools",
  "source": "dynamic",
  "status": "connected",
  "toolCount": 7,
  "validation": {
    "valid": true,
    "toolCount": 7,
    "tools": [
      {
        "name": "fetch-template-metadata",
        "description": "Search and retrieve Software Template metadata..."
      },
      {
        "name": "fetch-catalog-entities",
        "description": "Search and retrieve catalog entities..."
      }
    ]
  }
}
```

**Response** `404 Not Found` (server not found):

```json
{
  "error": "MCP server not found"
}
```

### 4.6 Validate Credentials Without Saving (Test Connection)

```
POST /api/lightspeed/mcp-servers/validate
```

**Permission**: `lightspeed.mcp.manage`

**Request Body**:

```json
{
  "url": "https://api.githubcopilot.com/mcp/",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

**Response** `200 OK`:

```json
{
  "valid": true,
  "toolCount": 12,
  "tools": [{ "name": "create_issue", "description": "Create a GitHub issue" }]
}
```

---

## 5. Frontend UI Mapping

This table maps the user's UI requirements to the API endpoints:

| UI Element                           | API Call                                    | Notes                                                            |
| ------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| MCP Server list table                | `GET /mcp-servers`                          | Shows `name`, `status` (green check if `connected`), `toolCount` |
| "Add MCP Server" button → form       | `POST /mcp-servers`                         | User enters name, URL, token. Validation runs automatically.     |
| Toggle switch (on/off)               | `PATCH /mcp-servers/:id` `{enabled: false}` | Instant — no re-validation. Disabled servers excluded from chat. |
| Pencil icon → edit PAT dialog        | `PATCH /mcp-servers/:id`                    | Frontend sends `{ token: "new_value" }`. Backend re-validates.   |
| Delete icon                          | `DELETE /mcp-servers/:id`                   | Only shown for `source: "dynamic"` servers                       |
| "Test Connection" button in add form | `POST /mcp-servers/validate`                | Validates without saving                                         |
| Status column refresh                | `POST /mcp-servers/:id/validate`            | Re-checks credentials on demand                                  |

### Status Column Display Logic

| `status`    | `valid` from last validation | Display                              |
| ----------- | ---------------------------- | ------------------------------------ |
| `connected` | `true`                       | ✅ Green check + `{toolCount} tools` |
| `error`     | `false`                      | ❌ Red X + error tooltip             |
| `unknown`   | N/A                          | ⏳ Loading spinner (validating...)   |

> **Note**: Static servers always return `status: "unknown"` from `GET /mcp-servers` because they are not validated at list time. The frontend should immediately fire `POST /mcp-servers/:id/validate` for each server after rendering the list. The `unknown` state is transient — it only appears while the validate call is in flight. Once the response arrives, the status updates to `connected` or `error`.

---

## 6. LCS Integration — MCP-HEADERS and Server Registration

Two integration points connect the Backstage backend to LCS for MCP servers:

1. **Registration API** — Backstage tells LCS about new dynamic MCP servers (name + URL)
2. **MCP-HEADERS** — Backstage sends per-user tokens on every chat query

### 6.1 LCS "Client" Auth Model

LCS supports multiple MCP server authentication methods ([LCS README — Configuring MCP Server Authentication](https://github.com/lightspeed-core/lightspeed-stack/blob/main/README.md#configuring-mcp-server-authentication)). For dynamic MCP servers managed via the Backstage UI, we use the **client-provided tokens** method:

```yaml
# How LCS sees a dynamic MCP server after registration
mcp_servers:
  - name: 'GitHub'
    url: 'https://api.githubcopilot.com/mcp/'
    provider_id: 'model-context-protocol'
    authorization_headers:
      Authorization: 'client' # ← tells LCS: "get the real token from MCP-HEADERS"
```

When `authorization_headers.Authorization` is set to `"client"`, LCS expects the actual Bearer token to arrive via the `MCP-HEADERS` HTTP header on each `/v1/streaming_query` request. This is exactly what Backstage sends — a per-user token on every chat query.

**Key behaviors of the "client" auth model**:

- If no `MCP-HEADERS` entry is provided for a client-auth server on a given request, **LCS automatically skips that server** for that request (no error, just a warning log)
- This is perfect for per-user MCP servers: User A's query includes their GitHub token, User B's query includes their own token, and users who haven't configured GitHub simply don't send a token — LCS skips it

### 6.2 LCS Registration API (Dynamic Servers)

LCS exposes a runtime registration API for adding MCP servers without restarting:

| Endpoint                 | Method   | Description                                               |
| ------------------------ | -------- | --------------------------------------------------------- |
| `/v1/mcp-servers`        | `POST`   | Register a new MCP server                                 |
| `/v1/mcp-servers`        | `GET`    | List all MCP servers (with `source: "config"` or `"api"`) |
| `/v1/mcp-servers/{name}` | `DELETE` | Remove a dynamically registered server (403 for static)   |

**Registration request**:

```json
POST /v1/mcp-servers
{
  "name": "GitHub",
  "url": "https://api.githubcopilot.com/mcp/",
  "provider_id": "model-context-protocol",
  "authorization_headers": {
    "Authorization": "client"
  }
}
```

- Only `name` and `url` are required; `provider_id` defaults to `"model-context-protocol"`
- Returns `201 Created` on success, `409 Conflict` if the name already exists
- LCS validates the request, creates a config object, and registers the toolgroup with Llama Stack
- If Llama Stack registration fails, LCS rolls back the local config change

**Per-user namespacing**: Backstage registers each dynamic server using its **database UUID** as the LCS `name`, not the user-facing name. This ensures per-user isolation — if User A and User B both register a server named "github" (same or different URL), each gets a separate LCS entry (e.g., `abc-123-uuid` and `def-456-uuid`). LCS and Llama Stack accept different names pointing to the same URL without conflict. At query time, `MCP-HEADERS` uses the same UUID as the key, so LCS correctly routes each user's token to the right toolgroup.

**Backstage calls this API** when:

- A user adds a new dynamic MCP server via `POST /api/lightspeed/mcp-servers`
- A user updates the URL via `PATCH /api/lightspeed/mcp-servers/:id` (unregister old UUID + register same UUID with new URL)
- A user deletes a dynamic MCP server via `DELETE /api/lightspeed/mcp-servers/:id`
- On startup — to re-sync all dynamic servers (LCS stores registrations in memory, so they are lost on LCS restart)

### 6.3 MCP-HEADERS at Query Time

When a user sends a chat query (`POST /v1/query`), the Backstage backend builds `MCP-HEADERS` by merging both sources, **scoped to the requesting user**:

```
                        /v1/query request
                        (user: maysun)
                              │
                              ▼
                   ┌─────────────────────┐
                   │  Build MCP-HEADERS  │
                   │                     │
                   │  1. Read static     │
                   │     config servers  │
                   │     (shared tokens) │
                   │                     │
                   │  2. Read maysun's   │
                   │     dynamic servers │
                   │     (status =       │
                   │      "connected")   │
                   │                     │
                   │  3. Merge into      │
                   │     header map      │
                   └─────────┬───────────┘
                             │
                             ▼
              ┌──────────────────────────────────┐
              │ POST to LCS                      │
              │ /v1/streaming_query              │
              │                                  │
              │ Header: MCP-HEADERS = {          │
              │   "test-mcp-server": {           │  ← static: uses config name
              │     "Authorization": "..."       │
              │   },                             │
              │   "6fea5076-e857-...": {         │  ← dynamic: uses DB UUID
              │     "Authorization": "..."       │
              │   }                              │
              │ }                                │
              └──────────────────────────────────┘
```

**Static servers** use their config name as the MCP-HEADERS key (admin-managed, no per-user collision). **Dynamic servers** use their database UUID as the key — this matches the namespaced identifier registered with LCS, ensuring per-user isolation. Only the `Authorization` header is included; no URL. LCS already knows the URL either from its static config or from the registration API.

Only the **requesting user's** dynamic servers with `status: "connected"` and `enabled: true` are included. Users who haven't configured a dynamic server simply don't send a token for it — LCS automatically skips that server for the request.

### 6.4 End-to-End Flow

Here is the complete lifecycle when a user adds a dynamic MCP server:

```
  User (UI)              Backstage Backend              LCS
    │                          │                          │
    │  POST /mcp-servers       │                          │
    │  {name, url, token}      │                          │
    │─────────────────────────▶│                          │
    │                          │                          │
    │                          │  1. Save to DB            │
    │                          │  2. Validate against      │
    │                          │     MCP server directly   │
    │                          │     (initialize handshake)│
    │                          │                          │
    │                          │  POST /v1/mcp-servers    │
    │                          │  {name, url,             │
    │                          │   authorization_headers:  │
    │                          │   {Authorization:"client"}}│
    │                          │─────────────────────────▶│
    │                          │                          │
    │                          │  201 Created (or 409)    │
    │                          │◀─────────────────────────│
    │                          │                          │
    │  201 {server, validation,│                          │
    │       lcsRegistered}     │                          │
    │◀─────────────────────────│                          │
    │                          │                          │
    │  ... later, chat query...│                          │
    │                          │                          │
    │  POST /v1/query          │                          │
    │─────────────────────────▶│                          │
    │                          │                          │
    │                          │  POST /v1/streaming_query│
    │                          │  MCP-HEADERS: {          │
    │                          │    "GitHub": {           │
    │                          │      "Authorization":    │
    │                          │      "Bearer ghp_xxx"    │
    │                          │    }                     │
    │                          │  }                       │
    │                          │─────────────────────────▶│
    │                          │                          │
    │                          │  LCS resolves "GitHub"   │
    │                          │  from registration,      │
    │                          │  connects to URL with    │
    │                          │  the Bearer token        │
    │◀─────────────────────────│◀─────────────────────────│
```

### 6.5 Startup Sync

LCS stores dynamic MCP server registrations **in memory**. If LCS restarts, all dynamic registrations are lost. To handle this, the Backstage backend **re-registers all dynamic servers with LCS on startup**:

1. Query all dynamic MCP servers from the database (across all users)
2. Deduplicate by server name (multiple users may share the same server name)
3. For each unique server, call `POST /v1/mcp-servers` on LCS
4. Handle `409 Conflict` gracefully (server already exists — no action needed)

This runs asynchronously and does not block the backend from starting. If LCS is temporarily unavailable, registration failures are logged as warnings and the servers will be registered on the next add/update operation.

### 6.6 Multi-User Name Considerations

Multiple users can add a dynamic server with the same name (e.g., "GitHub") but with their own tokens. The Backstage DB supports this via the `UNIQUE(name, created_by)` constraint. However, LCS has a **flat namespace** — only one server per name.

**How this works in practice**:

- The first user to add "GitHub" triggers the LCS registration with their URL
- Subsequent users adding "GitHub" trigger a `409 Conflict` from LCS — this is expected and handled gracefully
- At query time, each user sends their own Bearer token via `MCP-HEADERS` regardless
- If users provide different URLs for the same name, the first registration wins in LCS — this is acceptable because MCP server URLs for a given name (e.g., GitHub Copilot MCP) are typically the same across users; only the PAT differs

**Deletion safety**: When a user deletes their "GitHub" entry, the backend only unregisters from LCS if **no other user** still has a server with that name

---

## 7. Credential Validation Protocol

The validator connects to the MCP server using the **Streamable HTTP** transport (the standard for remote MCP servers):

```
  Backend                           MCP Server
    │                                   │
    │  POST {url}                       │
    │  Authorization: Bearer {token}    │
    │  Body: { initialize }             │
    │──────────────────────────────────▶│
    │                                   │
    │  200 OK { capabilities }          │
    │◀──────────────────────────────────│
    │                                   │
    │  POST {url}                       │
    │  Body: { initialized notif }      │
    │──────────────────────────────────▶│
    │                                   │
    │  POST {url}                       │
    │  Body: { tools/list }             │
    │──────────────────────────────────▶│
    │                                   │
    │  200 OK { tools: [...] }          │
    │◀──────────────────────────────────│
```

**Timeout**: 10 seconds per request. If the server doesn't respond, status is set to `error`.

**Auth failure**: HTTP 401/403 → `{ valid: false, error: "Invalid credentials" }`.

---

## 8. Permissions

New permissions added to `@red-hat-developer-hub/backstage-plugin-lightspeed-common`:

| Permission              | Resource    | Used For                                  |
| ----------------------- | ----------- | ----------------------------------------- |
| `lightspeed.mcp.read`   | MCP Servers | List configured MCP servers               |
| `lightspeed.mcp.manage` | MCP Servers | Add, update, delete, validate MCP servers |

For RHDH with RBAC, administrators would assign these permissions to appropriate roles. With the default `allow-all` policy, all authenticated users have access.

---

## 9. Configuration Guide

### 9.1 Local Development

The existing `app-config.yaml` already has database configuration:

```yaml
backend:
  database:
    client: better-sqlite3
    connection: ':memory:'
```

This uses in-memory SQLite — works out of the box, no setup needed. MCP servers added via the UI will persist until the backend restarts.

For **persistent local storage** (survives restarts), change to a directory path:

```yaml
backend:
  database:
    client: better-sqlite3
    connection:
      directory: './sqlite-data'
```

Backstage creates one `.sqlite` file per plugin inside that directory (e.g., `sqlite-data/lightspeed.sqlite`). The directory path is resolved relative to the backend working directory (`packages/backend/`).

Static MCP servers can still be defined in config for development:

```yaml
lightspeed:
  mcpServers:
    - name: mcp-integration-tools
      url: https://mcp.example.com/
      token: ${MCP_TOKEN_1}
```

### 9.2 OpenShift / RHDH

RHDH deployments include PostgreSQL. The database configuration is managed by the Helm chart or Operator:

```yaml
backend:
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
```

The lightspeed plugin automatically creates its schema (`lightspeed_mcp_servers` table) on first startup via Knex migrations.

**No additional setup is required** — the plugin reuses the existing RHDH database.

---

## 10. File Changes Summary

| File                                                                      | Change                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `plugins/lightspeed-backend/migrations/20260302120000_add_mcp_servers.js` | **New** — Knex migration                                |
| `plugins/lightspeed-backend/src/database/migration.ts`                    | **New** — Migration runner                              |
| `plugins/lightspeed-backend/src/service/mcp-server-types.ts`              | **New** — TypeScript types                              |
| `plugins/lightspeed-backend/src/service/mcp-server-store.ts`              | **New** — Database CRUD                                 |
| `plugins/lightspeed-backend/src/service/mcp-server-validator.ts`          | **New** — Credential validation                         |
| `plugins/lightspeed-backend/src/plugin.ts`                                | **Modified** — Add database dependency                  |
| `plugins/lightspeed-backend/src/service/types.ts`                         | **Modified** — Add `DatabaseService` to `RouterOptions` |
| `plugins/lightspeed-backend/src/service/router.ts`                        | **Modified** — Add MCP server endpoints                 |
| `plugins/lightspeed-backend/config.d.ts`                                  | **Modified** — Add `url` to config schema               |
| `plugins/lightspeed-backend/package.json`                                 | **Modified** — Add `migrations` to `files`              |
| `plugins/lightspeed-common/src/permissions.ts`                            | **Modified** — Add MCP permissions                      |
| `app-config.yaml`                                                         | **Modified** — Add `url` example                        |
