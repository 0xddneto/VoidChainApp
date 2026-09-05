/**
 * Saving a profile.
 *
 * The only thing that decides whose profile is written is a signature over the
 * exact payload. The body says which address it claims to be; the signature is
 * what proves it, and the two have to agree or nothing is written.
 */
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createPublicClient, getAddress, isAddress } from 'viem';
import { profileIdentity, saveProfile, type Social } from '@/lib/chains';
import { canonicalProfile, profileMessage } from '@/lib/profile-signature';
import { pool } from '@/lib/db';
import { relayClientId } from '@/lib/relay-guard';
import { rhTransport } from '@/lib/testnet';

const MAX_AVATAR_BYTES = 650_000;
const MAX_REQUEST_BYTES = 950_000;
const signatureClient = createPublicClient({ transport: rhTransport() });

function isSupportedImage(bytes: Buffer): boolean {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || webp;
}

function validAvatarUri(value: string): boolean {
  if (!value) return true;
  if (value.startsWith('https://')) return value.length <= 400;
  const match = value.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64');
  return decoded.byteLength <= MAX_AVATAR_BYTES && isSupportedImage(decoded);
}

async function admitProfileWrite(req: Request, address: string): Promise<boolean> {
  const clientHash = createHash('sha256').update(relayClientId(req)).digest();
  const addressBytes = Buffer.from(address.slice(2), 'hex');
  const client = await pool.connect().catch(() => null);
  if (!client) return false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`profile-client:${clientHash.toString('hex')}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`profile-user:${address.toLowerCase()}`]);
    await client.query("DELETE FROM profile_requests WHERE created_at < now() - interval '7 days'");
    const count = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM profile_requests
       WHERE created_at > now() - interval '1 minute'
         AND (client_hash = $1 OR user_address = $2)`,
      [clientHash, addressBytes],
    );
    if (Number(count.rows[0].n) >= 10) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO profile_requests (client_hash, user_address) VALUES ($1,$2)', [clientHash, addressBytes]);
    await client.query('COMMIT');
    return true;
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return false;
  } finally { client.release(); }
}

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get('address');
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'a valid address is required' }, { status: 400 });
  }

  return NextResponse.json(await profileIdentity(address));
}

export async function POST(req: Request) {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'profile request is too large' }, { status: 413 });
  }
  let body: {
    address?: string;
    nonce?: string;
    signature?: `0x${string}`;
    displayName?: string;
    avatarUri?: string;
    bio?: string;
    socials?: Social[];
  };

  try {
    const raw = Buffer.from(await req.arrayBuffer());
    if (raw.byteLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: 'profile request is too large' }, { status: 413 });
    }
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return NextResponse.json({ error: 'malformed body' }, { status: 400 });
  }

  const { address, nonce, signature } = body;
  if (!address || !isAddress(address) || !nonce || !signature) {
    return NextResponse.json({ error: 'address, nonce and signature are required' }, { status: 400 });
  }

  // The nonce carries the moment it was minted, so a captured signature stops
  // working. Without it, one signature would rewrite the profile forever.
  const minted = Number(nonce.split('.')[0]);
  if (!Number.isFinite(minted) || Math.abs(Date.now() - minted) > 10 * 60 * 1000) {
    return NextResponse.json({ error: 'this request expired, sign again' }, { status: 400 });
  }

  const profile = canonicalProfile({
    displayName: body.displayName,
    avatarUri: body.avatarUri,
    bio: body.bio,
    socials: body.socials,
  });
  // viem's client action supports EOAs and ERC-1271 smart-contract wallets.
  const ok = await signatureClient.verifyMessage({
    address: getAddress(address),
    message: profileMessage(address, nonce, profile),
    signature,
  }).catch(() => false);

  if (!ok) {
    return NextResponse.json({ error: 'the signature does not match that address' }, { status: 401 });
  }
  if (!await admitProfileWrite(req, address)) {
    return NextResponse.json({ error: 'too many profile updates; wait one minute and try again' }, { status: 429 });
  }

  const avatarUri = profile.avatarUri;
  if (!validAvatarUri(avatarUri)) {
    return NextResponse.json({ error: 'profile image must be a real PNG, JPEG or WEBP under 650 KB' }, { status: 400 });
  }

  await saveProfile(address, {
    displayName: profile.displayName,
    avatarUri,
    bio: profile.bio,
    socials: profile.socials,
  });

  return NextResponse.json({ ok: true });
}
