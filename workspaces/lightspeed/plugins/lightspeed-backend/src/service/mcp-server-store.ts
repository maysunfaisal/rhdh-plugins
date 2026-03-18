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

import { Knex } from 'knex';

import { randomUUID } from 'node:crypto';

import {
  McpServerCreateInput,
  McpServerRow,
  McpServerStatus,
  McpServerUpdateInput,
} from './mcp-server-types';

const TABLE = 'lightspeed_mcp_servers';

export class McpServerStore {
  constructor(private readonly db: Knex) {}

  /** List all dynamic MCP servers across all users (for startup LCS sync). */
  async listAll(): Promise<McpServerRow[]> {
    return this.db<McpServerRow>(TABLE)
      .select('*')
      .orderBy('created_at', 'asc');
  }

  /** List all MCP servers belonging to a specific user. */
  async listByUser(userEntityRef: string): Promise<McpServerRow[]> {
    return this.db<McpServerRow>(TABLE)
      .where({ created_by: userEntityRef })
      .select('*')
      .orderBy('created_at', 'asc');
  }

  /** Find a server by id, scoped to the owning user. */
  async findById(
    id: string,
    userEntityRef: string,
  ): Promise<McpServerRow | undefined> {
    return this.db<McpServerRow>(TABLE)
      .where({ id, created_by: userEntityRef })
      .first();
  }

  /** Check for name uniqueness within a user's servers. */
  async findByName(
    name: string,
    userEntityRef: string,
  ): Promise<McpServerRow | undefined> {
    return this.db<McpServerRow>(TABLE)
      .where({ name, created_by: userEntityRef })
      .first();
  }

  async create(
    input: McpServerCreateInput,
    createdBy: string,
  ): Promise<McpServerRow> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: McpServerRow = {
      id,
      name: input.name,
      url: input.url,
      token: input.token,
      status: 'unknown',
      enabled: true,
      tool_count: 0,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    };
    await this.db(TABLE).insert(row);
    return row;
  }

  async update(
    id: string,
    userEntityRef: string,
    input: McpServerUpdateInput,
  ): Promise<McpServerRow | undefined> {
    const existing = await this.findById(id, userEntityRef);
    if (!existing) return undefined;

    const updates: Partial<McpServerRow> = {
      updated_at: new Date().toISOString(),
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.url !== undefined) updates.url = input.url;
    if (input.token !== undefined) {
      updates.token = input.token;
      updates.status = 'unknown';
    }
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    await this.db(TABLE)
      .where({ id, created_by: userEntityRef })
      .update(updates);
    return this.findById(id, userEntityRef);
  }

  async updateStatus(
    id: string,
    status: McpServerStatus,
    toolCount: number,
  ): Promise<void> {
    await this.db(TABLE).where({ id }).update({
      status,
      tool_count: toolCount,
      updated_at: new Date().toISOString(),
    });
  }

  async delete(id: string, userEntityRef: string): Promise<boolean> {
    const rows = await this.db(TABLE)
      .where({ id, created_by: userEntityRef })
      .del();
    return rows > 0;
  }
}
