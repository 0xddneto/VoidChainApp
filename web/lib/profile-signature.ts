import { keccak256, toHex } from 'viem';

export type SignedSocial = { platform: string; handle: string };
export type SignedProfile = {
  displayName: string;
  avatarUri: string;
  bio: string;
  socials: SignedSocial[];
};

/** One canonical payload for both the browser signature and server write. */
export function canonicalProfile(value: Partial<SignedProfile>): SignedProfile {
  return {
    displayName: (typeof value.displayName === 'string' ? value.displayName : '').slice(0, 64),
    avatarUri: typeof value.avatarUri === 'string' ? value.avatarUri : '',
    bio: (typeof value.bio === 'string' ? value.bio : '').slice(0, 500),
    socials: (Array.isArray(value.socials) ? value.socials : []).slice(0, 8).filter((social) => social && typeof social.platform === 'string' && typeof social.handle === 'string').map((social) => ({
      platform: social.platform.trim().slice(0, 32),
      handle: social.handle.trim().slice(0, 64),
    })).filter((social) => social.platform && social.handle),
  };
}

export function profileMessage(address: string, nonce: string, profile: SignedProfile): string {
  const payloadHash = keccak256(toHex(JSON.stringify(canonicalProfile(profile))));
  return [
    'VoidScan — update profile',
    '',
    `address: ${address.toLowerCase()}`,
    `nonce: ${nonce}`,
    `profile: ${payloadHash}`,
    '',
    'Signing saves exactly this profile. It costs no gas and moves nothing.',
  ].join('\n');
}
