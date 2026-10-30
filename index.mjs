export const name = 'dsh-agent-mesh';
export const inject = ['tools', 'agents', 'sessionController', 'workspaceRegistry', 'sessionQuery'];

// The packaged Loader caches ESM modules by URL for the process lifetime; keep
// this entry stable and re-import the implementation per activation.
export async function apply(ctx, config) {
  const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const host = await import(`./host.mjs?rev=${rev}`);
  return host.apply(ctx, config);
}
