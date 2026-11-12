/**
 * Ask Coop's Claude client settings. A workspace-scoped key needs only ANTHROPIC_API_KEY. An org-scoped key (created
 * outside a workspace) must name the workspace to run and bill in, sent as the anthropic-workspace-id header, or
 * every call fails with 400 "not scoped to a workspace". Same rule as Goldline's GOLDLINE_ANTHROPIC_WORKSPACE_ID
 * (src/goldline-extract-run.ts). Null = no key, so the chat route answers "not configured".
 */
export function anthropicClientOptions(
  env: Record<string, string | undefined>,
): {apiKey: string; defaultHeaders?: Record<string, string>} | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID?.trim();
  return workspaceId ? {apiKey, defaultHeaders: {'anthropic-workspace-id': workspaceId}} : {apiKey};
}
