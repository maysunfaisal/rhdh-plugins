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

import { type BackendFeature } from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';

import { setupServer } from 'msw/node';
import request from 'supertest';

import { handlers } from '../../__fixtures__/handlers';
import { lcsHandlers, resetMcpServers } from '../../__fixtures__/lcsHandlers';
import {
  mcpHandlers,
  MOCK_MCP_ADDR,
  MOCK_MCP_VALID_TOKEN,
} from '../../__fixtures__/mcpHandlers';
import { lightspeedPlugin } from '../plugin';

const mockUserId = 'user:default/user1';

const BASE_CONFIG = {
  lightspeed: {
    servers: [
      {
        id: 'test-server',
        url: 'http://localhost:443/v1',
        token: 'dummy-token',
      },
    ],
  },
};

const MCP_CONFIG = {
  lightspeed: {
    ...BASE_CONFIG.lightspeed,
    mcpServers: [
      {
        name: 'static-mcp',
        url: MOCK_MCP_ADDR,
        token: MOCK_MCP_VALID_TOKEN,
      },
    ],
  },
};

jest.mock('@backstage/backend-plugin-api', () => ({
  ...jest.requireActual('@backstage/backend-plugin-api'),
  UserInfoService: jest.fn().mockImplementation(() => ({
    getUserInfo: jest.fn().mockResolvedValue({
      BackstageUserInfo: {
        userEntityRef: mockUserId,
      },
    }),
  })),
}));

describe('MCP server management endpoints', () => {
  const server = setupServer(...handlers, ...lcsHandlers, ...mcpHandlers);

  beforeAll(() => {
    server.listen({
      onUnhandledRequest: (req, print) => {
        if (req.url.includes('/api/lightspeed')) {
          return;
        }
        print.warning();
      },
    });
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
    server.resetHandlers();
    resetMcpServers();
  });

  async function startBackendServer(
    config?: Record<PropertyKey, unknown>,
    authorizeResult?: AuthorizeResult.DENY | AuthorizeResult.ALLOW,
  ) {
    const features: (BackendFeature | Promise<{ default: BackendFeature }>)[] =
      [
        lightspeedPlugin,
        mockServices.rootLogger.factory(),
        mockServices.rootConfig.factory({
          data: { ...BASE_CONFIG, ...(config || {}) },
        }),
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.user(mockUserId),
        }),
        mockServices.permissions.mock({
          authorize: async () => [
            { result: authorizeResult ?? AuthorizeResult.ALLOW },
          ],
        }).factory,
        mockServices.userInfo.factory(),
      ];
    return (await startTestBackend({ features })).server;
  }

  // ─── GET /mcp-servers ─────────────────────────────────────────────

  describe('GET /mcp-servers', () => {
    it('returns empty list when no MCP servers configured', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer).get(
        '/api/lightspeed/mcp-servers',
      );

      expect(response.status).toBe(200);
      expect(response.body.servers).toEqual([]);
    });

    it('returns static servers from config', async () => {
      const backendServer = await startBackendServer(MCP_CONFIG);
      const response = await request(backendServer).get(
        '/api/lightspeed/mcp-servers',
      );

      expect(response.status).toBe(200);
      expect(response.body.servers).toHaveLength(1);
      expect(response.body.servers[0]).toMatchObject({
        id: 'static-static-mcp',
        name: 'static-mcp',
        source: 'static',
        status: 'unknown',
        enabled: true,
      });
    });

    it('returns both static and dynamic servers', async () => {
      const backendServer = await startBackendServer(MCP_CONFIG);

      await request(backendServer).post('/api/lightspeed/mcp-servers').send({
        name: 'dynamic-mcp',
        url: MOCK_MCP_ADDR,
        token: MOCK_MCP_VALID_TOKEN,
      });

      const response = await request(backendServer).get(
        '/api/lightspeed/mcp-servers',
      );

      expect(response.status).toBe(200);
      expect(response.body.servers).toHaveLength(2);

      const sources = response.body.servers.map((s: any) => s.source);
      expect(sources).toContain('static');
      expect(sources).toContain('dynamic');
    });

    it('returns 403 when permission denied', async () => {
      const backendServer = await startBackendServer(
        MCP_CONFIG,
        AuthorizeResult.DENY,
      );
      const response = await request(backendServer).get(
        '/api/lightspeed/mcp-servers',
      );

      expect(response.status).toBe(403);
    });
  });

  // ─── POST /mcp-servers ────────────────────────────────────────────

  describe('POST /mcp-servers', () => {
    it('creates a dynamic MCP server with valid credentials', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'test-github',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      expect(response.status).toBe(201);
      expect(response.body.server).toMatchObject({
        name: 'test-github',
        url: MOCK_MCP_ADDR,
        status: 'connected',
        enabled: true,
        source: 'dynamic',
      });
      expect(response.body.validation.valid).toBe(true);
      expect(response.body.validation.toolCount).toBe(3);
      expect(response.body.lcsRegistered).toBe(true);
    });

    it('creates server with invalid credentials and sets status to error', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'test-bad-creds',
          url: MOCK_MCP_ADDR,
          token: 'invalid-token',
        });

      expect(response.status).toBe(201);
      expect(response.body.server.status).toBe('error');
      expect(response.body.validation.valid).toBe(false);
    });

    it('returns 400 when required fields missing', async () => {
      const backendServer = await startBackendServer();

      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({ name: 'test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        'name, url, and token are required',
      );
    });

    it('returns 409 when name already exists for user', async () => {
      const backendServer = await startBackendServer();

      await request(backendServer).post('/api/lightspeed/mcp-servers').send({
        name: 'duplicate',
        url: MOCK_MCP_ADDR,
        token: MOCK_MCP_VALID_TOKEN,
      });

      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'duplicate',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('already exists');
    });

    it('returns 403 when permission denied', async () => {
      const backendServer = await startBackendServer(
        undefined,
        AuthorizeResult.DENY,
      );
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'denied',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      expect(response.status).toBe(403);
    });
  });

  // ─── PATCH /mcp-servers/:id ───────────────────────────────────────

  describe('PATCH /mcp-servers/:id', () => {
    it('updates token and re-validates', async () => {
      const backendServer = await startBackendServer();

      const createRes = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'patch-test',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      const serverId = createRes.body.server.id;

      const patchRes = await request(backendServer)
        .patch(`/api/lightspeed/mcp-servers/${serverId}`)
        .send({ token: 'invalid-token' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.server.status).toBe('error');
      expect(patchRes.body.validation).toBeDefined();
      expect(patchRes.body.validation.valid).toBe(false);
    });

    it('toggles enabled without re-validation', async () => {
      const backendServer = await startBackendServer();

      const createRes = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'toggle-test',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      const serverId = createRes.body.server.id;

      const patchRes = await request(backendServer)
        .patch(`/api/lightspeed/mcp-servers/${serverId}`)
        .send({ enabled: false });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.server.enabled).toBe(false);
      expect(patchRes.body.validation).toBeUndefined();
    });

    it('toggles enabled back on', async () => {
      const backendServer = await startBackendServer();

      const createRes = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'toggle-on',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      const serverId = createRes.body.server.id;

      await request(backendServer)
        .patch(`/api/lightspeed/mcp-servers/${serverId}`)
        .send({ enabled: false });

      const patchRes = await request(backendServer)
        .patch(`/api/lightspeed/mcp-servers/${serverId}`)
        .send({ enabled: true });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.server.enabled).toBe(true);
    });

    it('rejects patching a static server', async () => {
      const backendServer = await startBackendServer(MCP_CONFIG);
      const patchRes = await request(backendServer)
        .patch('/api/lightspeed/mcp-servers/static-static-mcp')
        .send({ token: 'new-token' });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.error).toContain('static configuration server');
    });

    it('returns 404 for non-existent server', async () => {
      const backendServer = await startBackendServer();
      const patchRes = await request(backendServer)
        .patch('/api/lightspeed/mcp-servers/non-existent-uuid')
        .send({ token: 'new-token' });

      expect(patchRes.status).toBe(404);
    });

    it('returns 400 when no fields provided', async () => {
      const backendServer = await startBackendServer();
      const patchRes = await request(backendServer)
        .patch('/api/lightspeed/mcp-servers/some-id')
        .send({});

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.error).toContain('At least one of');
    });
  });

  // ─── DELETE /mcp-servers/:id ──────────────────────────────────────

  describe('DELETE /mcp-servers/:id', () => {
    it('deletes a dynamic server and unregisters from LCS', async () => {
      const backendServer = await startBackendServer();

      const createRes = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'delete-me',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      const serverId = createRes.body.server.id;

      const deleteRes = await request(backendServer).delete(
        `/api/lightspeed/mcp-servers/${serverId}`,
      );

      expect(deleteRes.status).toBe(204);

      const listRes = await request(backendServer).get(
        '/api/lightspeed/mcp-servers',
      );
      const names = listRes.body.servers.map((s: any) => s.name);
      expect(names).not.toContain('delete-me');
    });

    it('rejects deleting a static server', async () => {
      const backendServer = await startBackendServer(MCP_CONFIG);
      const deleteRes = await request(backendServer).delete(
        '/api/lightspeed/mcp-servers/static-static-mcp',
      );

      expect(deleteRes.status).toBe(400);
      expect(deleteRes.body.error).toContain('static configuration server');
    });

    it('returns 404 for non-existent server', async () => {
      const backendServer = await startBackendServer();
      const deleteRes = await request(backendServer).delete(
        '/api/lightspeed/mcp-servers/non-existent-uuid',
      );

      expect(deleteRes.status).toBe(404);
    });

    it('returns 403 when permission denied', async () => {
      const backendServer = await startBackendServer(
        undefined,
        AuthorizeResult.DENY,
      );
      const deleteRes = await request(backendServer).delete(
        '/api/lightspeed/mcp-servers/some-id',
      );

      expect(deleteRes.status).toBe(403);
    });
  });

  // ─── POST /mcp-servers/validate (generic) ─────────────────────────

  describe('POST /mcp-servers/validate', () => {
    it('validates valid credentials', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers/validate')
        .send({ url: MOCK_MCP_ADDR, token: MOCK_MCP_VALID_TOKEN });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.toolCount).toBe(3);
      expect(response.body.tools).toHaveLength(3);
    });

    it('validates invalid credentials', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers/validate')
        .send({ url: MOCK_MCP_ADDR, token: 'bad-token' });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
    });

    it('returns 400 when url or token missing', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer)
        .post('/api/lightspeed/mcp-servers/validate')
        .send({ url: MOCK_MCP_ADDR });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('url and token are required');
    });
  });

  // ─── POST /mcp-servers/:id/validate (on-demand) ──────────────────

  describe('POST /mcp-servers/:id/validate', () => {
    it('validates a static server using stored credentials', async () => {
      const backendServer = await startBackendServer(MCP_CONFIG);
      const response = await request(backendServer).post(
        '/api/lightspeed/mcp-servers/static-static-mcp/validate',
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 'static-static-mcp',
        name: 'static-mcp',
        source: 'static',
        status: 'connected',
        toolCount: 3,
      });
      expect(response.body.validation.valid).toBe(true);
      expect(response.body.validation.tools).toHaveLength(3);
    });

    it('validates a dynamic server and updates DB status', async () => {
      const backendServer = await startBackendServer();

      const createRes = await request(backendServer)
        .post('/api/lightspeed/mcp-servers')
        .send({
          name: 'validate-dynamic',
          url: MOCK_MCP_ADDR,
          token: MOCK_MCP_VALID_TOKEN,
        });

      const serverId = createRes.body.server.id;

      const response = await request(backendServer).post(
        `/api/lightspeed/mcp-servers/${serverId}/validate`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: serverId,
        name: 'validate-dynamic',
        source: 'dynamic',
        status: 'connected',
        toolCount: 3,
      });
    });

    it('returns 404 for non-existent static server', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer).post(
        '/api/lightspeed/mcp-servers/static-nonexistent/validate',
      );

      expect(response.status).toBe(404);
    });

    it('returns 404 for non-existent dynamic server', async () => {
      const backendServer = await startBackendServer();
      const response = await request(backendServer).post(
        '/api/lightspeed/mcp-servers/non-existent-uuid/validate',
      );

      expect(response.status).toBe(404);
    });

    it('returns 403 when permission denied', async () => {
      const backendServer = await startBackendServer(
        MCP_CONFIG,
        AuthorizeResult.DENY,
      );
      const response = await request(backendServer).post(
        '/api/lightspeed/mcp-servers/static-static-mcp/validate',
      );

      expect(response.status).toBe(403);
    });
  });
});
