/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { createPermissionIntegrationRouter } from '@backstage/plugin-permission-node';

import express, { Router } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  lightspeedChatCreatePermission,
  lightspeedChatDeletePermission,
  lightspeedChatReadPermission,
  lightspeedMcpManagePermission,
  lightspeedMcpReadPermission,
  lightspeedPermissions,
} from '@red-hat-developer-hub/backstage-plugin-lightspeed-common';

import { Readable } from 'node:stream';

import { McpServerStore } from './mcp-server-store';
import {
  McpServerResponse,
  McpServerRow,
  McpServerStatus,
  McpValidationResult,
} from './mcp-server-types';
import { McpServerValidator } from './mcp-server-validator';
import { userPermissionAuthorization } from './permission';
import {
  DEFAULT_HISTORY_LENGTH,
  QueryRequestBody,
  RouterOptions,
} from './types';
import { validateCompletionsRequest } from './validation';

const SKIP_USER_ID_ENDPOINTS = new Set(['/v1/models', '/v1/shields']);

function toResponse(row: McpServerRow): McpServerResponse {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    enabled: Boolean(row.enabled),
    toolCount: row.tool_count,
    source: 'dynamic',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Build MCP-HEADERS for LCS.  Format matches the LCS "client" auth model:
 *   { "server-name": { "Authorization": "Bearer <token>" } }
 *
 * Static servers use their config name as the key (admin-managed, no collision).
 * Dynamic servers use their DB UUID as the key — this matches the namespaced
 * identifier registered with LCS via POST /v1/mcp-servers, ensuring per-user
 * isolation even when multiple users register servers with the same name.
 */
async function buildMcpHeaders(
  staticHeaders: Record<string, { Authorization: string }>,
  store: McpServerStore,
  userEntityRef: string,
): Promise<string> {
  const merged: Record<string, { Authorization: string }> = {
    ...staticHeaders,
  };

  const dynamicServers = await store.listByUser(userEntityRef);
  for (const server of dynamicServers) {
    if (server.enabled && server.status === 'connected') {
      merged[server.id] = {
        Authorization: `Bearer ${server.token}`,
      };
    }
  }

  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : '';
}

// ─── LCS Registration Helpers ────────────────────────────────────────
// LCS requires dynamic MCP servers to be registered via its API so it
// knows the server name, URL, and that auth comes from MCP-HEADERS
// (authorization_headers.Authorization = "client").

async function registerServerWithLcs(
  lcsPort: number,
  name: string,
  url: string,
  log: LoggerService,
): Promise<boolean> {
  try {
    const response = await fetch(`http://0.0.0.0:${lcsPort}/v1/mcp-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        url,
        provider_id: 'model-context-protocol',
        authorization_headers: { Authorization: 'client' },
      }),
    });

    if (response.status === 201) {
      log.info(`Registered MCP server '${name}' with LCS`);
      return true;
    }
    if (response.status === 409) {
      log.info(`MCP server '${name}' already registered with LCS`);
      return true;
    }

    log.warn(
      `Failed to register MCP server '${name}' with LCS: HTTP ${response.status}`,
    );
    return false;
  } catch (error) {
    log.warn(`Failed to register MCP server '${name}' with LCS: ${error}`);
    return false;
  }
}

async function unregisterServerFromLcs(
  lcsPort: number,
  name: string,
  log: LoggerService,
): Promise<void> {
  try {
    const response = await fetch(
      `http://0.0.0.0:${lcsPort}/v1/mcp-servers/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );

    if (response.ok || response.status === 404) {
      log.info(`Unregistered MCP server '${name}' from LCS`);
    } else if (response.status === 403) {
      log.info(
        `MCP server '${name}' is statically configured in LCS — skipping unregister`,
      );
    } else {
      log.warn(
        `Failed to unregister MCP server '${name}' from LCS: HTTP ${response.status}`,
      );
    }
  } catch (error) {
    log.warn(`Failed to unregister MCP server '${name}' from LCS: ${error}`);
  }
}

/**
 * @public
 * The lightspeed backend router
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, config, database, httpAuth, userInfo, permissions } = options;

  const router = Router();
  router.use(express.json());

  const port = config.getOptionalNumber('lightspeed.servicePort') ?? 8080;
  const system_prompt = config.getOptionalString('lightspeed.systemPrompt');

  // Build static MCP headers from app-config (backward compatible).
  // Static servers are already registered in LCS's own config with
  // authorization_headers.Authorization = "client", so we only need
  // to send the actual token in MCP-HEADERS at query time.
  const mcpServersConfig = config.getOptionalConfigArray(
    'lightspeed.mcpServers',
  );
  const staticMcpHeaders: Record<string, { Authorization: string }> = {};
  const staticMcpUrls: Record<string, string> = {};
  const staticMcpTokens: Record<string, string> = {};
  if (mcpServersConfig) {
    for (const mcpServer of mcpServersConfig) {
      const name = mcpServer.getString('name');
      const token = mcpServer.getString('token');
      const url = mcpServer.getOptionalString('url');
      staticMcpHeaders[name] = { Authorization: `Bearer ${token}` };
      staticMcpTokens[name] = token;
      if (url) staticMcpUrls[name] = url;
    }
  }

  // Initialize database-backed store and validator
  const dbClient = await database.getClient();
  const mcpStore = new McpServerStore(dbClient);
  const mcpValidator = new McpServerValidator(logger);

  // Sync dynamic MCP servers with LCS on startup.
  // LCS dynamic registrations are in-memory, so they're lost on LCS restart.
  // Re-registering existing servers ensures they're available for queries.
  // Each server is registered using its DB UUID as the LCS identifier,
  // so multiple users can register servers with the same name without collision.
  const allDynamicServers = await mcpStore.listAll();
  for (const server of allDynamicServers) {
    registerServerWithLcs(port, server.id, server.url, logger).catch(() => {});
  }

  router.get('/health', (_, response) => {
    response.json({ status: 'ok' });
  });

  const permissionIntegrationRouter = createPermissionIntegrationRouter({
    permissions: lightspeedPermissions,
  });
  router.use(permissionIntegrationRouter);

  const authorizer = userPermissionAuthorization(permissions);

  // ─── MCP Server Management Endpoints ────────────────────────────────
  // Registered before the proxy middleware so they are matched first.

  router.get('/mcp-servers', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(lightspeedMcpReadPermission, credentials);
      const user = await userInfo.getUserInfo(credentials);

      // Static config servers (shared — visible to everyone, always enabled)
      const staticServers: McpServerResponse[] = Object.keys(
        staticMcpHeaders,
      ).map(name => ({
        id: `static-${name}`,
        name,
        url: staticMcpUrls[name] ?? '',
        status: 'unknown' as McpServerStatus,
        enabled: true,
        toolCount: 0,
        source: 'static' as const,
      }));

      // Dynamic DB servers scoped to the requesting user
      const dynamicRows = await mcpStore.listByUser(user.userEntityRef);
      const dynamicServers = dynamicRows.map(toResponse);

      res.json({ servers: [...staticServers, ...dynamicServers] });
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error listing MCP servers: ${error}`);
        res.status(500).json({ error: 'Failed to list MCP servers' });
      }
    }
  });

  router.post('/mcp-servers/validate', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(
        lightspeedMcpManagePermission,
        credentials,
      );

      const { url, token } = req.body;
      if (!url || !token) {
        res.status(400).json({ error: 'url and token are required' });
        return;
      }

      const result = await mcpValidator.validate(url, token);
      res.json(result);
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error validating MCP credentials: ${error}`);
        res.status(500).json({ error: 'Validation failed' });
      }
    }
  });

  router.post('/mcp-servers/:id/validate', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(lightspeedMcpReadPermission, credentials);
      const user = await userInfo.getUserInfo(credentials);

      const { id } = req.params;

      let serverUrl: string;
      let serverToken: string;
      let serverId: string;
      let serverName: string;
      let isStatic = false;

      if (id.startsWith('static-')) {
        const name = id.slice('static-'.length);
        const url = staticMcpUrls[name];
        const token = staticMcpTokens[name];
        if (!url || !token) {
          res.status(404).json({ error: 'Static MCP server not found' });
          return;
        }
        serverUrl = url;
        serverToken = token;
        serverId = id;
        serverName = name;
        isStatic = true;
      } else {
        const row = await mcpStore.findById(id, user.userEntityRef);
        if (!row) {
          res.status(404).json({ error: 'MCP server not found' });
          return;
        }
        serverUrl = row.url;
        serverToken = row.token;
        serverId = row.id;
        serverName = row.name;
      }

      const validation = await mcpValidator.validate(serverUrl, serverToken);
      const status: McpServerStatus = validation.valid ? 'connected' : 'error';

      if (!isStatic) {
        await mcpStore.updateStatus(serverId, status, validation.toolCount);
      }

      res.json({
        id: serverId,
        name: serverName,
        source: isStatic ? 'static' : 'dynamic',
        status,
        toolCount: validation.toolCount,
        validation,
      });
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error validating MCP server: ${error}`);
        res.status(500).json({ error: 'Validation failed' });
      }
    }
  });

  router.post('/mcp-servers', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(
        lightspeedMcpManagePermission,
        credentials,
      );
      const user = await userInfo.getUserInfo(credentials);

      const { name, url, token } = req.body;
      if (!name || !url || !token) {
        res.status(400).json({ error: 'name, url, and token are required' });
        return;
      }

      const existing = await mcpStore.findByName(name, user.userEntityRef);
      if (existing) {
        res
          .status(409)
          .json({ error: `MCP server with name '${name}' already exists` });
        return;
      }

      const row = await mcpStore.create(
        { name, url, token },
        user.userEntityRef,
      );

      // Validate credentials against the MCP server directly
      const validation = await mcpValidator.validate(url, token);
      const status: McpServerStatus = validation.valid ? 'connected' : 'error';
      await mcpStore.updateStatus(row.id, status, validation.toolCount);
      row.status = status;
      row.tool_count = validation.toolCount;

      // Register with LCS using the DB UUID as the identifier.
      // This ensures per-user isolation — even if two users register a server
      // with the same name, each gets its own LCS entry.
      // LCS uses authorization_headers.Authorization = "client", meaning
      // the real token will come via MCP-HEADERS at query time.
      const lcsRegistered = await registerServerWithLcs(
        port,
        row.id,
        url,
        logger,
      );

      res.status(201).json({
        server: toResponse(row),
        validation,
        lcsRegistered,
      });
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error creating MCP server: ${error}`);
        res.status(500).json({ error: 'Failed to create MCP server' });
      }
    }
  });

  router.patch('/mcp-servers/:id', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(
        lightspeedMcpManagePermission,
        credentials,
      );
      const user = await userInfo.getUserInfo(credentials);

      const { id } = req.params;

      if (id.startsWith('static-')) {
        res
          .status(400)
          .json({ error: 'Cannot modify a static configuration server' });
        return;
      }

      const { name, url, token, enabled } = req.body;
      if (
        name === undefined &&
        url === undefined &&
        token === undefined &&
        enabled === undefined
      ) {
        res.status(400).json({
          error:
            'At least one of name, url, token, or enabled must be provided',
        });
        return;
      }

      // Capture the old name/url before the update for LCS re-registration
      const existing = await mcpStore.findById(id, user.userEntityRef);
      if (!existing) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }

      const updated = await mcpStore.update(id, user.userEntityRef, {
        name,
        url,
        token,
        enabled,
      });
      if (!updated) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }

      // Only re-validate when credentials or URL changed (not on toggle)
      let validation: McpValidationResult | undefined;
      if (token !== undefined || url !== undefined) {
        validation = await mcpValidator.validate(updated.url, updated.token);
        const newStatus: McpServerStatus = validation.valid
          ? 'connected'
          : 'error';
        await mcpStore.updateStatus(
          updated.id,
          newStatus,
          validation.toolCount,
        );
        updated.status = newStatus;
        updated.tool_count = validation.toolCount;
      }

      // If URL changed, re-register with LCS under the same DB UUID
      if (url && url !== existing.url) {
        await unregisterServerFromLcs(port, existing.id, logger);
        await registerServerWithLcs(port, updated.id, updated.url, logger);
      }

      const response: Record<string, unknown> = {
        server: toResponse(updated),
      };
      if (validation) response.validation = validation;
      res.json(response);
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error updating MCP server: ${error}`);
        res.status(500).json({ error: 'Failed to update MCP server' });
      }
    }
  });

  router.delete('/mcp-servers/:id', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(
        lightspeedMcpManagePermission,
        credentials,
      );
      const user = await userInfo.getUserInfo(credentials);

      const { id } = req.params;

      if (id.startsWith('static-')) {
        res
          .status(400)
          .json({ error: 'Cannot delete a static configuration server' });
        return;
      }

      // Look up the server before deleting so we have its name for LCS
      const server = await mcpStore.findById(id, user.userEntityRef);
      if (!server) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }

      await mcpStore.delete(id, user.userEntityRef);

      // Unregister from LCS using the DB UUID — each user's registration is unique
      await unregisterServerFromLcs(port, server.id, logger);

      res.status(204).send();
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error deleting MCP server: ${error}`);
        res.status(500).json({ error: 'Failed to delete MCP server' });
      }
    }
  });

  router.post('/mcp-servers/:id/validate', async (req, res) => {
    try {
      const credentials = await httpAuth.credentials(req);
      await authorizer.authorizeUser(
        lightspeedMcpManagePermission,
        credentials,
      );
      const user = await userInfo.getUserInfo(credentials);

      const { id } = req.params;

      // Handle static servers — validate using config values
      if (id.startsWith('static-')) {
        const name = id.replace('static-', '');
        const header = staticMcpHeaders[name];
        const url = staticMcpUrls[name];
        if (!header || !url) {
          res.status(400).json({
            error: 'Static server has no URL configured — cannot validate',
          });
          return;
        }
        const tokenValue = header.Authorization.replace('Bearer ', '');
        const result = await mcpValidator.validate(url, tokenValue);
        res.json(result);
        return;
      }

      const server = await mcpStore.findById(id, user.userEntityRef);
      if (!server) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }

      const result = await mcpValidator.validate(server.url, server.token);
      const status: McpServerStatus = result.valid ? 'connected' : 'error';
      await mcpStore.updateStatus(id, status, result.toolCount);

      res.json(result);
    } catch (error) {
      if (error instanceof NotAllowedError) {
        res.status(403).json({ error: error.message });
      } else {
        logger.error(`Error validating MCP server: ${error}`);
        res.status(500).json({ error: 'Validation failed' });
      }
    }
  });

  // ─── Proxy Middleware (existing) ────────────────────────────────────

  router.use('/', async (req, res, next) => {
    const passthroughPaths = ['/v1/query', '/v1/feedback'];
    if (passthroughPaths.includes(req.path) || req.method === 'PUT') {
      return next();
    }
    // TODO: parse server_id from req.body and get URL and token when multi-server is supported
    const credentials = await httpAuth.credentials(req);
    const user = await userInfo.getUserInfo(credentials);
    const userEntity = user.userEntityRef;

    logger.info(`receives call from user: ${userEntity}`);
    try {
      if (req.method === 'GET') {
        await authorizer.authorizeUser(
          lightspeedChatReadPermission,
          credentials,
        );
      } else if (req.method === 'DELETE') {
        await authorizer.authorizeUser(
          lightspeedChatDeletePermission,
          credentials,
        );
      }
    } catch (error) {
      if (error instanceof NotAllowedError) {
        logger.error(error.message);
        return res.status(403).json({ error: error.message });
      }
    }
    // Proxy middleware configuration
    const apiProxy = createProxyMiddleware({
      target: `http://0.0.0.0:${port}`,
      changeOrigin: true,
      pathRewrite: (path, _) => {
        const isSkippable = Array.from(SKIP_USER_ID_ENDPOINTS).some(endpoint =>
          path.startsWith(endpoint),
        );

        if (isSkippable) {
          return path;
        }

        let newPath = path;

        // Add user_id
        const userQueryParam = `user_id=${encodeURIComponent(userEntity)}`;
        newPath = path.includes('?')
          ? `${path}&${userQueryParam}`
          : `${path}?${userQueryParam}`;

        // Add history_length if needed
        if (
          !path.includes('history_length') &&
          path.includes('conversation_id')
        ) {
          const historyLengthQuery = `history_length=${DEFAULT_HISTORY_LENGTH}`;
          newPath = newPath.includes('?')
            ? `${newPath}&${historyLengthQuery}`
            : `${newPath}?${historyLengthQuery}`;
        }

        logger.info(`Rewriting path from ${path} to ${newPath}`);
        return newPath;
      },
    });
    return apiProxy(req, res, next);
  });

  router.post('/v1/feedback', async (request, response) => {
    try {
      const credentials = await httpAuth.credentials(request);
      const userEntity = await userInfo.getUserInfo(credentials);
      const user_id = userEntity.userEntityRef;

      logger.info(`/v1/feedback receives call from user: ${user_id}`);

      await authorizer.authorizeUser(
        lightspeedChatCreatePermission,
        credentials,
      );
      const userQueryParam = `user_id=${encodeURIComponent(user_id)}`;
      const requestBody = JSON.stringify(request.body);
      const fetchResponse = await fetch(
        `http://0.0.0.0:${port}/v1/feedback?${userQueryParam}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: requestBody,
        },
      );

      if (!fetchResponse.ok) {
        // Read the error body
        const errorBody = await fetchResponse.json();
        const errormsg = `Error from lightspeed-core server: ${errorBody.error?.message || errorBody?.detail?.cause || 'Unknown error'}`;
        logger.error(errormsg);

        // Return a 500 status for any upstream error
        response.status(500).json({
          error: errormsg,
        });
      }

      const data = await fetchResponse.json();
      response.status(fetchResponse.status).json(data);
    } catch (error) {
      const errormsg = `Error while sending feedback: ${error}`;
      logger.error(errormsg);

      if (error instanceof NotAllowedError) {
        response.status(403).json({ error: error.message });
      } else {
        response.status(500).json({ error: errormsg });
      }
    }
  });
  router.post(
    '/v1/query',
    validateCompletionsRequest,
    async (request, response) => {
      const { provider }: Pick<QueryRequestBody, 'provider'> = request.body;
      try {
        const credentials = await httpAuth.credentials(request);
        const userEntity = await userInfo.getUserInfo(credentials);
        const user_id = userEntity.userEntityRef;

        logger.info(`/v1/query receives call from user: ${user_id}`);

        await authorizer.authorizeUser(
          lightspeedChatCreatePermission,
          credentials,
        );
        const userQueryParam = `user_id=${encodeURIComponent(user_id)}`;
        request.body.media_type = 'application/json'; // set media_type to receive start and end event
        // if system_prompt is defined in lightspeed config
        // set system_prompt to override the default rhdh system prompt
        if (system_prompt && system_prompt.trim().length > 0) {
          request.body.system_prompt = system_prompt;
        }

        const requestBody = JSON.stringify(request.body);

        // Build MCP headers dynamically from static config + this user's DB servers
        const mcpHeadersValue = await buildMcpHeaders(
          staticMcpHeaders,
          mcpStore,
          user_id,
        );

        const fetchResponse = await fetch(
          `http://0.0.0.0:${port}/v1/streaming_query?${userQueryParam}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'MCP-HEADERS': mcpHeadersValue,
            },
            body: requestBody,
          },
        );

        if (!fetchResponse.ok) {
          // Read the error body
          const errorBody = await fetchResponse.json();
          const errormsg = `Error from lightspeed-core server: ${errorBody.error?.message || errorBody?.detail?.cause || 'Unknown error'}`;
          logger.error(errormsg);

          // Return a 500 status for any upstream error
          response.status(500).json({
            error: errormsg,
          });

          return;
        }

        // Pipe the response back to the original response
        if (fetchResponse.body) {
          const nodeStream = Readable.fromWeb(fetchResponse.body as any);
          nodeStream.pipe(response);
        }
      } catch (error) {
        const errormsg = `Error fetching completions from ${provider}: ${error}`;
        logger.error(errormsg);

        if (error instanceof NotAllowedError) {
          response.status(403).json({ error: error.message });
        } else {
          response.status(500).json({ error: errormsg });
        }
      }
    },
  );

  router.put(
    '/v2/conversations/:conversation_id',
    async (request, response) => {
      try {
        const credentials = await httpAuth.credentials(request);
        const userEntity = await userInfo.getUserInfo(credentials);
        const user_id = userEntity.userEntityRef;
        const conversation_id = request.params.conversation_id;

        const requestBody = JSON.stringify(request.body);
        await authorizer.authorizeUser(
          lightspeedChatCreatePermission,
          credentials,
        );
        const userQueryParam = `user_id=${encodeURIComponent(user_id)}`;
        const fetchResponse = await fetch(
          `http://0.0.0.0:${port}/v2/conversations/${conversation_id}?${userQueryParam}`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            body: requestBody,
          },
        );
        if (!fetchResponse.ok) {
          // Read the error body
          const errorBody = await fetchResponse.json();
          const errormsg = `Error from lightspeed-core server: ${errorBody.error?.message || errorBody?.detail?.cause || 'Unknown error'}`;
          logger.error(errormsg);

          // Return a 500 status for any upstream error
          response.status(500).json({
            error: errormsg,
          });
          return;
        }

        const data = await fetchResponse.json();
        response.status(fetchResponse.status).json(data);
      } catch (error) {
        const errormsg = `Error while updating topic summary: ${error}`;
        logger.error(errormsg);

        if (error instanceof NotAllowedError) {
          response.status(403).json({ error: error.message });
        } else {
          response.status(500).json({ error: errormsg });
        }
      }
    },
  );

  const middleware = MiddlewareFactory.create({ logger, config });

  router.use(middleware.error());
  return router;
}
