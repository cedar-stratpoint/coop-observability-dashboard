// Worker tokens and one-time enrolment codes: random, shown once, stored only as a sha256 hash (columns token_hash / code_hash).
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

export const ENROL_TTL_MS = 15 * 60_000;

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');
/** 32 random bytes: the worker's long-lived token. */
export const newWorkerToken = (): string => `zsw_${randomBytes(32).toString('base64url')}`;
/** The one-time code a person pastes into the docker command. */
export const newEnrolmentCode = (): string => `zse_${randomBytes(24).toString('base64url')}`;

export function verifySecret(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export const enrolmentUsable = (e: {expiresAt: string; usedAt: string | null}, now: Date): boolean => e.usedAt === null && Date.parse(e.expiresAt) > now.getTime();
