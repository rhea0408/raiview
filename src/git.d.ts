/**
 * Type definitions for VS Code's built-in Git extension API.
 * See: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

export interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  repositories: Repository[];
}

export interface Repository {
  rootUri: import("vscode").Uri;
  state: RepositoryState;
}

export interface RepositoryState {
  indexChanges: Change[];
  workingTreeChanges: Change[];
}

export interface Change {
  uri: import("vscode").Uri;
  status: Status;
}

export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,

  ADDED_BY_US = 12,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}
