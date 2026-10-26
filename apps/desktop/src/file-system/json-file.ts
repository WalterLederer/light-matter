import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Serialize writes from the renderer config and startup-bounds persistence.
// Atomic replacement prevents readers from seeing a partially written JSON file.
const pendingWrites = new Map<string, Promise<void>>();

export const writeJsonAtomically = async (filePath: string, data: unknown): Promise<void> => {
  const previous = pendingWrites.get(filePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  });

  pendingWrites.set(filePath, operation);
  try {
    await operation;
  } finally {
    if (pendingWrites.get(filePath) === operation) {
      pendingWrites.delete(filePath);
    }
  }
};
