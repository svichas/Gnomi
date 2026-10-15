import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { BlobStore, ProjectStore, SessionStore, StorageState } from './seams.ts';

// Blob layout: format version, 12-byte IV, 16-byte GCM tag, then the ciphertext.
const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// A role is a file name: no dots or slashes, and lowercase only so Admin and admin cannot share a file on macOS.
export const ROLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function sessionPath(role: string): string {
  if (!ROLE.test(role)) throw new Error(`Invalid role name ${JSON.stringify(role)}: use 1-40 lowercase letters, digits, "-" or "_"`);
  return `sessions/${role}.session`;
}

export function createSessionStore(store: ProjectStore, blobs: BlobStore, keyHex: string): SessionStore {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('The session key must be 64 hex characters (32 bytes)');
  const key = Buffer.from(keyHex, 'hex');
  const infoOf = (role: string) => store.listSessions().find((s) => s.role === role) ?? null;

  return {
    list: () => store.listSessions(),
    async save(info, state) {
      const path = sessionPath(info.role);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      // The role is authenticated, so a blob copied under another role's path does not decrypt.
      cipher.setAAD(Buffer.from(info.role, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
      await blobs.put(path, Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), ciphertext]));
      store.putSession(info);
    },
    async load(role) {
      const path = sessionPath(role);
      const info = infoOf(role);
      if (!info) return null;
      try {
        const blob = Buffer.from(await blobs.get(path));
        if (blob[0] !== FORMAT) throw new Error('unknown format');
        const iv = blob.subarray(1, 1 + IV_BYTES);
        const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(role, 'utf8'));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(blob.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
        return { info, state: JSON.parse(plain.toString('utf8')) as StorageState };
      } catch {
        // No cause attached: a JSON parse error would quote plaintext.
        throw new Error(`The saved login for ${role} cannot be decrypted on this machine; record it again`);
      }
    },
    markVerified(role, at) {
      const info = infoOf(role);
      if (!info) throw new Error(`No recorded login for ${role}`);
      store.putSession({ ...info, verified_at: at });
    },
  };
}
