/**
 * Saving a profile.
 *
 * The only thing that decides whose profile is written is a signature over the
 * exact payload. The body says which address it claims to be; the signature is
 * what proves it, and the two have to agree or nothing is written.
 */
import { NextResponse } from 'next/server';
import { verifyMessage, isAddress } from 'viem';
import { saveProfile, type Social } from '@/lib/chains';

/** The message the wallet signs. Reproduced here so the server checks the same text. */
export function profileMessage(address: string, nonce: string): string {
  return [
    'VoidScan — update profile',
    '',
    `address: ${address.toLowerCase()}`,
    `nonce: ${nonce}`,
    '',
    'Signing this proves the wallet is yours. It costs no gas and moves nothing.',
  ].join('\n');
}

export async function POST(req: Request) {
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
    body = await req.json();
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

  const ok = await verifyMessage({
    address,
    message: profileMessage(address, nonce),
    signature,
  }).catch(() => false);

  if (!ok) {
    return NextResponse.json({ error: 'the signature does not match that address' }, { status: 401 });
  }

  await saveProfile(address, {
    displayName: (body.displayName ?? '').slice(0, 64),
    avatarUri: (body.avatarUri ?? '').slice(0, 400),
    bio: (body.bio ?? '').slice(0, 500),
    socials: (body.socials ?? []).slice(0, 8),
  });

  return NextResponse.json({ ok: true });
}
