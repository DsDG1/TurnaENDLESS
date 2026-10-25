import { z } from 'zod';
import { UuidSchema } from './envelope.js';

/** 云工作区（§4.1 / §5.2）。C1 只建 owner 归属，不开放协作权限。 */

/** C1 仅登记当前存档格式；长期云信封 endless-cloud-workspace/1 属 C4。 */
export const WorkspaceContractSchema = z.enum(['endless-workspace/1']);
export type WorkspaceContract = z.infer<typeof WorkspaceContractSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  contract: WorkspaceContractSchema,
  /** 原本地库 ID 映射锚（可选）；同 account+sourceLocalId 幂等复用，不重复建实例。 */
  sourceLocalId: z.string().trim().min(1).max(128).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CloudWorkspaceSchema = z.object({
  id: UuidSchema,
  sourceLocalId: z.string().nullable(),
  contract: WorkspaceContractSchema,
  cloudVersion: z.string().regex(/^\d+$/),
  status: z.enum(['active', 'archived']),
  role: z.literal('owner'),
  createdAt: z.string().datetime(),
});
export type CloudWorkspace = z.infer<typeof CloudWorkspaceSchema>;

export const WorkspaceListResponseSchema = z.object({ workspaces: z.array(CloudWorkspaceSchema) });
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;

export const CreateWorkspaceResponseSchema = z.object({ workspace: CloudWorkspaceSchema });
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;
