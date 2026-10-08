import { InjectionToken } from '@angular/core';
import {
  backupFileName,
  MAX_BACKUP_BYTES,
  treeBackupSchema,
  type TreeBackup,
  type TreeBackupInput,
} from '@tangent/shared';

/*
 * JSON backups as files, for both apps: reading one chosen with a file input
 * (Import) and saving one the API returned (Learn's Export). The format is
 * the server's (`tangent-tree-backup`), so a file made by either app imports
 * into the other.
 */

/** What reading a backup needs of a `File`. */
export type BackupFile = Pick<File, 'name' | 'size' | 'text'>;

/**
 * Reads and validates a JSON backup chosen with a file input. Throws an Error
 * whose message names the file and says what is wrong: empty, too large, not
 * JSON (e.g. a Markdown or HTML export), from a newer version, not a backup,
 * or a damaged one.
 */
export async function readBackupFile(
  file: BackupFile,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<TreeBackupInput> {
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (file.size > maxBytes) {
    throw new Error(
      `${file.name} is too large to import (${megabytes(file.size)}; the limit is ${megabytes(maxBytes)}).`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error(
      `${file.name} is not a JSON file. Import takes a JSON backup (.tangent.json), not a Markdown or HTML export.`,
    );
  }
  const format = isRecord(json) ? json['format'] : undefined;
  if (format !== 'tangent-tree-backup') {
    throw new Error(`${file.name} is not a Tangent backup.`);
  }
  const version = isRecord(json) ? json['version'] : undefined;
  if (typeof version === 'number' && version > 1) {
    throw new Error(
      `${file.name} was made by a newer version of Tangent and can’t be imported here.`,
    );
  }
  const result = treeBackupSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${file.name} is a damaged Tangent backup${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}.`,
    );
  }
  return result.data;
}

/** A backup as a downloadable file: the server's JSON, under the server's file name. */
export function backupFile(backup: TreeBackup): { name: string; blob: Blob } {
  return {
    name: backupFileName(backup.tree.title),
    blob: new Blob([JSON.stringify(backup)], { type: 'application/json' }),
  };
}

/** Hands a file to the browser's downloads. */
export type SaveFile = (name: string, blob: Blob) => void;

/**
 * How the apps save a file they made (the default: a temporary object URL
 * behind a `download` link). A token so tests, which have no DOM, can see
 * what would be saved.
 */
export const SAVE_FILE = new InjectionToken<SaveFile>('SAVE_FILE', {
  providedIn: 'root',
  factory: () => saveWithLink,
});

function saveWithLink(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start the download after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
