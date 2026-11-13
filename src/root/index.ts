export { extractTree, listTree, type TreeEntry } from './archive.js';
export {
  buildRoot,
  layoutOf,
  RootError,
  ROOT_NAMES,
  type BuiltRoot,
  type ContextEntry,
  type ContextFromPath,
  type ContextFromRepo,
  type ContextSource,
  type ExpectedEntry,
  type RootInputs,
  type RootLayout,
} from './build.js';
export {
  DATA_PREFIX,
  dataLines,
  ITEM_ID,
  quoteName,
  renderPreviousReviews,
  renderPrMd,
  type EarlierItem,
  type PrComment,
  type PrData,
} from './data-files.js';
export { CHANGED_FILES_UNKNOWN, detectFold, type FallbackKind, type FoldPlan } from './fold.js';
export {
  FULL_SHA,
  GIT_ISOLATION_CONFIG,
  GitError,
  gitEnv,
  NEUTRAL_ATTRIBUTES,
  openShadow,
  runGit,
  type GitOptions,
  type ShadowRepo,
} from './git.js';
export { diffManifests, hashManifest, manifestOf, treeHash, type ManifestChange, type ManifestEntry } from './hash.js';
export { assertIntegrity, checkIntegrity, IntegrityError } from './integrity.js';
export { decodeName, FileNameError } from './names.js';
export {
  AGENT_CONFIG_DIRS,
  AGENT_CONFIG_FILES,
  AGENT_CONFIG_QUARANTINE,
  agentConfigDir,
  agentConfigFile,
  COUNCIL_DATA_SUFFIX,
  sanitizedPathMap,
  sanitizeTrees,
  workspaceConfigIn,
  type SanitizedEntry,
} from './sanitize.js';
export {
  prepareRoot,
  sealRoot,
  sweepResidue,
  type BriefLike,
  type PreparedRoot,
  type ResidueReport,
  type SealedRoot,
  type SealOptions,
} from './seal.js';
export { escapingLinks, linkProblem, neutralizeSymlinks, symlinkText, type LinkProblem, type NeutralizedLink } from './symlinks.js';
