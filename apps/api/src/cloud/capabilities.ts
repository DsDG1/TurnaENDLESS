import type { CloudCapabilities } from '@endless/cloud-contracts';
import { CLOUD_LIMITS, CLOUD_PROTOCOL_VERSION } from '@endless/cloud-contracts';

/**
 * 能力发现（§14.1）：如实报告。未实现的能力恒为 false，
 * 客户端据此隐藏入口；不得把目标写成已完成。
 */
export function cloudCapabilities(enabled: { objects?: boolean; imports?: boolean } = {}): CloudCapabilities {
  return {
    protocol: CLOUD_PROTOCOL_VERSION,
    features: {
      accounts: true,
      sessions: true,
      devices: true,
      workspaces: true,
      import: enabled.imports ?? false,
      objects: enabled.objects ?? false,
      sync: false,
      generation: false,
      credits: false,
      billing: false,
      payments: false,
      exports: false,
      edition: false,
    },
    contracts: { workspace: 'endless-workspace/1' },
    limits: {
      controlBodyBytes: CLOUD_LIMITS.controlBodyBytes,
      uploadObjectBytes: CLOUD_LIMITS.uploadObjectBytes,
      eventsPerBatch: CLOUD_LIMITS.eventsPerBatch,
      listPageDefault: CLOUD_LIMITS.listPageDefault,
      listPageMax: CLOUD_LIMITS.listPageMax,
      quoteTtlSeconds: CLOUD_LIMITS.quoteTtlSeconds,
      queueSeconds: CLOUD_LIMITS.queueSeconds,
    },
  };
}
