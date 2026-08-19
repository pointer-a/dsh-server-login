/**
 * Symmetric encryption for per-user secrets at rest. AES-256-GCM with a
 * key derived from the deployment secret, so a DB leak does not yield usable
 * API keys (references-not-secrets).
 * @module dsh-server-login/crypto
 */
/** Derive a 32-byte AES key from the deployment secret (sha-256). */
export declare function deriveKey(secret: string): Buffer;
/** Encrypt a plaintext secret into a base64 payload `iv.tag.data`. */
export declare function encrypt(plain: string, key: Buffer): string;
/** Decrypt a payload produced by {@link encrypt}. */
export declare function decrypt(payload: string, key: Buffer): string;
