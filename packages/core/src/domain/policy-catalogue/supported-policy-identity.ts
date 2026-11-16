const SUPPORTED_POLICY_IDENTITY = /^sha256-v1:[0-9a-f]{64}$/u;

export function isSupportedPolicyIdentity(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_POLICY_IDENTITY.test(value);
}
