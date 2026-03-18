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

/** Database row shape for the lightspeed_mcp_servers table. */
export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  token: string;
  status: McpServerStatus;
  enabled: boolean;
  tool_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type McpServerStatus = 'connected' | 'error' | 'unknown';

/** Input when creating a new MCP server via the API. */
export interface McpServerCreateInput {
  name: string;
  url: string;
  token: string;
}

/** Input when updating an existing MCP server via the API. */
export interface McpServerUpdateInput {
  name?: string;
  url?: string;
  token?: string;
  enabled?: boolean;
}

/** Public-facing response (token is never exposed). */
export interface McpServerResponse {
  id: string;
  name: string;
  url: string;
  status: McpServerStatus;
  enabled: boolean;
  toolCount: number;
  source: 'static' | 'dynamic';
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpValidationResult {
  valid: boolean;
  toolCount: number;
  tools: McpToolInfo[];
  error?: string;
}
