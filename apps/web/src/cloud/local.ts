import {
  CloudImportReceiptSchema, IdempotencyKeySchema, UuidSchema, WorkspaceInstallationSchema,
  type CloudImportReceipt, type WorkspaceInstallation,
} from '@endless/cloud-contracts';
import { stableStringify } from '@endless/esl';

export interface CloudLocalInstallation {
  receipt: CloudImportReceipt;
  acknowledgements: { deviceId: string; key: string; receipt?: WorkspaceInstallation }[];
}

export function cloudNamespace(deploymentId: string, accountId: string, workspaceId: string) {
  const ids = [deploymentId, accountId, workspaceId].map((id) => UuidSchema.parse(id).toLowerCase());
  return `endless-cloud:${ids.join(':')}`;
}

export function isCloudNamespace(namespace: string) {
  const parts = namespace.split(':');
  return parts.length === 4 && parts[0] === 'endless-cloud' && parts.slice(1).every((id) => UuidSchema.safeParse(id).success);
}

export function parseCloudInstallation(raw: unknown): CloudLocalInstallation {
  const value = raw as CloudLocalInstallation;
  const receipt = CloudImportReceiptSchema.parse(value?.receipt);
  if (!Array.isArray(value.acknowledgements)) throw new Error('云副本安装记录损坏，原数据保留');
  return { receipt, acknowledgements: value.acknowledgements.map((entry) => ({
    deviceId: UuidSchema.parse(entry.deviceId), key: IdempotencyKeySchema.parse(entry.key),
    ...(entry.receipt ? { receipt: WorkspaceInstallationSchema.parse(entry.receipt) } : {}),
  })) };
}

export async function cloudDigest(value: unknown) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
