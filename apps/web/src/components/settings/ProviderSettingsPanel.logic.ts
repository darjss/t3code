import type { EnvironmentId } from "@t3tools/contracts";

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) {
      return leftIsPrimary ? -1 : 1;
    }
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  | { readonly kind: "loading" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase:
    | "available"
    | "offline"
    | "connecting"
    | "reconnecting"
    | "connected"
    | "error";
  readonly hasServerConfig: boolean;
  readonly canOperate: boolean | null;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading" };
  }
  if (input.canOperate === false) {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}
