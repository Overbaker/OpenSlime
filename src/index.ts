// CCG - Claude + Codex + Gemini Multi-Model Collaboration System
export * from './types'
export { init } from './commands/init'
export { showMainMenu } from './commands/menu'
export { update } from './commands/update'
export { i18n, initI18n, changeLanguage } from './i18n'
export {
  readCcgConfig,
  writeCcgConfig,
  createDefaultConfig,
  createDefaultRouting,
  getCcgDir,
  getConfigPath,
} from './utils/config'
export {
  configureAllSponsorsForCodex,
  configureApiMartForCodex,
  configurePackyCodeForCodex,
  configureSponsorForCodex,
  getWorkflowConfigs,
  getWorkflowById,
  installWorkflows,
  installAceTool,
  installAceToolRs,
  installCodexMode,
  removeAllSponsorsFromCodex,
  removeApiMartFromCodex,
  removePackyCodeFromCodex,
  removeSponsorFromCodex,
  uninstallCodexMode,
  uninstallWorkflows,
  uninstallAceTool,
} from './utils/installer'
export {
  migrateToV1_4_0,
  needsMigration,
} from './utils/migration'
export {
  getCurrentVersion,
  getLatestVersion,
  checkForUpdates,
  compareVersions,
} from './utils/version'

// Native skill catalog and managed selection lifecycle.
export { getSkillCatalog, listSkills, installedNames, installSkills, updateSkills, removeSkills, syncSkills, resolveSkillPaths } from './utils/skill-manager'
export type { SkillManagerOptions, SkillTarget, SkillListEntry } from './utils/skill-manager'
