import type { RoomState } from './protocol';

const INVITE_PREFIX = 'ERF-I1';
const JOIN_PREFIX = 'ERF-J1';
const INVITE_AAD = bytes('erfgooiers/webrtc/invite/v1');
const JOIN_INFO = bytes('erfgooiers/webrtc/join/v1');

export const INVITE_LIFETIME_MS = 15 * 60 * 1000;

export interface PeerInvite {
  kind: 'invite';
  createdAt: number;
  expiresAt: number;
  nonce: string;
  room: RoomState;
  offer: RTCSessionDescriptionInit;
  hostPublicKey: string;
}

export interface PeerJoin {
  kind: 'join';
  roomId: string;
  inviteNonce: string;
  guestNonce: string;
  playerName: string;
  safetyCode: string;
  answer: RTCSessionDescriptionInit;
}

export async function createHostKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', source(unbase64url(value)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/**
 * Encrypt and authenticate the offer as an opaque bearer capability. The
 * random AES key travels in the copied code: secrecy comes from sharing the
 * complete code privately, while AES-GCM prevents unnoticed modification.
 */
export async function sealInvite(invite: PeerInvite): Promise<string> {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const key = await importAesKey(keyBytes);
  const plaintext = bytes(JSON.stringify(invite));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(iv), additionalData: source(INVITE_AAD) }, key, source(plaintext),
  );
  return `${INVITE_PREFIX}.${base64url(keyBytes)}.${base64url(concat(iv, new Uint8Array(ciphertext)))}`;
}

export async function openInvite(code: string, now = Date.now()): Promise<PeerInvite> {
  const [prefix, encodedKey, encodedPayload, ...rest] = code.trim().split('.');
  if (prefix !== INVITE_PREFIX || !encodedKey || !encodedPayload || rest.length) throw new Error('Invalid encrypted invite code');
  try {
    const packed = unbase64url(encodedPayload);
    const key = await importAesKey(unbase64url(encodedKey));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: source(packed.slice(0, 12)), additionalData: source(INVITE_AAD) }, key, source(packed.slice(12)),
    );
    const invite = JSON.parse(new TextDecoder().decode(plaintext)) as PeerInvite;
    validateInvite(invite, now);
    return invite;
  } catch (error) {
    if (error instanceof Error && error.message === 'This invite has expired') throw error;
    throw new Error('Invite authentication failed');
  }
}

export async function sealJoin(
  join: PeerJoin,
  guestPrivateKey: CryptoKey,
  guestPublicKey: CryptoKey,
  hostPublicKey: CryptoKey,
): Promise<string> {
  const publicKey = await exportPublicKey(guestPublicKey);
  const key = await deriveJoinKey(guestPrivateKey, hostPublicKey, join.inviteNonce, join.roomId);
  const iv = randomBytes(12);
  const aad = joinAad(publicKey, join.roomId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(iv), additionalData: source(aad) }, key, source(bytes(JSON.stringify(join))),
  );
  return `${JOIN_PREFIX}.${publicKey}.${base64url(concat(iv, new Uint8Array(ciphertext)))}`;
}

export async function openJoin(
  code: string,
  hostPrivateKey: CryptoKey,
  invite: PeerInvite,
): Promise<PeerJoin> {
  const [prefix, publicKeyValue, encodedPayload, ...rest] = code.trim().split('.');
  if (prefix !== JOIN_PREFIX || !publicKeyValue || !encodedPayload || rest.length) throw new Error('Invalid encrypted join response');
  try {
    const guestPublicKey = await importPublicKey(publicKeyValue);
    const key = await deriveJoinKey(hostPrivateKey, guestPublicKey, invite.nonce, invite.room.id);
    const packed = unbase64url(encodedPayload);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: source(packed.slice(0, 12)), additionalData: source(joinAad(publicKeyValue, invite.room.id)) },
      key,
      source(packed.slice(12)),
    );
    const join = JSON.parse(new TextDecoder().decode(plaintext)) as PeerJoin;
    if (join.kind !== 'join' || join.roomId !== invite.room.id || join.inviteNonce !== invite.nonce) {
      throw new Error('Join response belongs to another invite');
    }
    if (!join.playerName || join.playerName.length > 24 || join.answer.type !== 'answer' || !join.answer.sdp) {
      throw new Error('Join response is incomplete');
    }
    const expectedSafetyCode = await deriveSafetyCode(hostPrivateKey, guestPublicKey, invite.nonce, invite.room.id);
    if (join.safetyCode !== expectedSafetyCode) throw new Error('Join response verification failed');
    return join;
  } catch (error) {
    if (error instanceof Error && (error.message.includes('another invite') || error.message.includes('incomplete'))) throw error;
    throw new Error('Join response authentication failed');
  }
}

export function randomToken(bytesLength = 16): string { return base64url(randomBytes(bytesLength)); }

/** Six decimal digits for an out-of-band verbal comparison before admission. */
export async function deriveSafetyCode(
  privateKey: CryptoKey, publicKey: CryptoKey, nonce: string, roomId: string,
): Promise<string> {
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', source(concat(new Uint8Array(secret), unbase64url(nonce), bytes(roomId))),
  ));
  const value = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000;
  return value.toString().padStart(6, '0');
}

function validateInvite(invite: PeerInvite, now: number): void {
  if (invite.kind !== 'invite' || !invite.nonce || !invite.room?.id || invite.offer?.type !== 'offer' || !invite.offer.sdp || !invite.hostPublicKey) {
    throw new Error('Invalid invite payload');
  }
  if (!Number.isFinite(invite.expiresAt) || invite.expiresAt < now) throw new Error('This invite has expired');
  if (!Number.isFinite(invite.createdAt) || invite.expiresAt - invite.createdAt > INVITE_LIFETIME_MS + 1000) {
    throw new Error('Invalid invite lifetime');
  }
}

async function deriveJoinKey(privateKey: CryptoKey, publicKey: CryptoKey, nonce: string, roomId: string): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: source(unbase64url(nonce)), info: source(concat(JOIN_INFO, bytes(`/${roomId}`))) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function joinAad(publicKey: string, roomId: string): Uint8Array {
  return bytes(`${JOIN_PREFIX}/${roomId}/${publicKey}`);
}

function importAesKey(value: Uint8Array): Promise<CryptoKey> {
  if (value.byteLength !== 32) throw new Error('Invalid AES key');
  return crypto.subtle.importKey('raw', source(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function base64url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** Web Crypto's DOM declarations require a non-shared, exactly bounded buffer. */
function source(value: Uint8Array): ArrayBuffer { return value.slice().buffer as ArrayBuffer; }
