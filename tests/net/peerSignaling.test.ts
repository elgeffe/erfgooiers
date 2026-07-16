import { describe, expect, it } from 'vitest';
import type { RoomState } from '../../src/net/protocol';
import {
  INVITE_LIFETIME_MS, createHostKeyPair, deriveSafetyCode, exportPublicKey, importPublicKey, openInvite, openJoin,
  randomToken, sealInvite, sealJoin, type PeerInvite, type PeerJoin,
} from '../../src/net/peerSignaling';

const room: RoomState = {
  id: 'room-test', inviteCode: 'TEST-2345', phase: 'lobby', level: 1,
  settings: {
    visibility: 'unlisted', roomName: 'Encrypted Polder', region: 'Europe',
    difficulty: 'erfgooiers', mode: 'expedition', passwordProtected: false,
  },
  players: [{
    id: 'p1', name: 'Ada', color: '#5b8c5a', hero: null, host: true, ready: false,
    presence: 'reconnecting', lastSeenAt: 1,
  }],
  protocolVersion: 1, contentVersion: 1,
};

describe('encrypted peer signaling', () => {
  it('round-trips an authenticated, expiring invite', async () => {
    const keys = await createHostKeyPair();
    const invite = await makeInvite(keys, 10_000);
    const code = await sealInvite(invite);

    expect(code).toMatch(/^ERF-I2\./);
    expect(code).not.toContain('Encrypted Polder');
    expect(code.length).toBeLessThan(JSON.stringify(invite).length);
    expect(await openInvite(code, 10_001)).toEqual(invite);
  });

  it('rejects tampered and expired invites', async () => {
    const keys = await createHostKeyPair();
    const invite = await makeInvite(keys, 10_000);
    const code = await sealInvite(invite);
    const parts = code.split('.');
    const middle = Math.floor(parts[2].length / 2);
    parts[2] = `${parts[2].slice(0, middle)}${parts[2][middle] === 'A' ? 'B' : 'A'}${parts[2].slice(middle + 1)}`;

    await expect(openInvite(parts.join('.'), 10_001)).rejects.toThrow('authentication failed');
    await expect(openInvite(code, 10_000 + INVITE_LIFETIME_MS + 1)).rejects.toThrow('expired');
  });

  it('encrypts a join response so only the invited host can open it', async () => {
    const host = await createHostKeyPair();
    const guest = await createHostKeyPair();
    const wrongHost = await createHostKeyPair();
    const invite = await makeInvite(host, Date.now());
    const hostPublicKey = await importPublicKey(invite.hostPublicKey);
    const join: PeerJoin = {
      kind: 'join', roomId: room.id, inviteNonce: invite.nonce, guestNonce: randomToken(),
      playerName: 'Bram', safetyCode: await deriveSafetyCode(guest.privateKey, hostPublicKey, invite.nonce, room.id),
      answer: { type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 guest' },
    };
    const code = await sealJoin(join, guest.privateKey, guest.publicKey, hostPublicKey);

    expect(code).toMatch(/^ERF-J2\./);
    expect(code).not.toContain('Bram');
    await expect(openJoin(code, host.privateKey, invite)).resolves.toEqual(join);
    await expect(openJoin(code, wrongHost.privateKey, invite)).rejects.toThrow('authentication failed');
  });
});

async function makeInvite(keys: CryptoKeyPair, now: number): Promise<PeerInvite> {
  return {
    kind: 'invite', createdAt: now, expiresAt: now + INVITE_LIFETIME_MS, nonce: randomToken(),
    room, offer: {
      type: 'offer',
      sdp: `v=0\r\na=fingerprint:sha-256 host\r\n${'a=candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host\r\n'.repeat(20)}`,
    },
    hostPublicKey: await exportPublicKey(keys.publicKey),
  };
}
