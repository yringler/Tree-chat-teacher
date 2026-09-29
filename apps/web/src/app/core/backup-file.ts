import { treeBackupSchema, type TreeBackup } from '@tangent/shared';

/** Reads and validates a JSON backup chosen with a file input. Throws with a readable message. */
export async function readBackupFile(file: File): Promise<TreeBackup> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not a JSON file.`);
  }
  const result = treeBackupSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${file.name} is not a Tangent backup${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}.`,
    );
  }
  return result.data;
}
