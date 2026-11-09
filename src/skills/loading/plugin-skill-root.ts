export type PluginSkillRoot = {
  dir: string;
  rejectHardlinks: boolean;
  /** Owning plugin; same-named skills from different plugins are namespaced by it. */
  pluginId?: string;
  /** Shipped with OpenClaw; a single bundled owner keeps the plain name on collision. */
  bundled?: boolean;
};
