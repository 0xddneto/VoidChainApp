/**
 * A holder's profile: who they are, what they own, and what it earned.
 *
 * The identity half — name, avatar, bio, links — is off-chain and is whatever
 * the holder typed. The ownership half is read from the deed contract through
 * the indexer. The page keeps them visually separate for that reason: one is a
 * claim, the other is a fact.
 */
import { notFound } from 'next/navigation';
import { isAddress } from 'viem';
import { profilePage } from '@/lib/chains';
import { Copyable } from '../../Copyable';
import { ProfileEditor } from '../ProfileEditor';
import styles from '../../page.module.css';
import { WalletProfileButton } from '../../WalletProfileButton';
import { ProfileAvatarEditor } from './ProfileAvatarEditor';
import own from './page.module.css';

export const dynamic = 'force-dynamic';

const nf = new Intl.NumberFormat('en-US');

function voidAmount(wei: string): string {
  const v = BigInt(wei || '0');
  if (v === 0n) return '0';
  return (Number(v / 10n ** 15n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export default async function ProfileRoute({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!isAddress(address)) notFound();

  const { profile, chains, revenue, calls } = await profilePage(address);

  return (
    <>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.bar}`}>
          <div className={styles.logo}>VOID<span>SCAN</span></div>
          <a className={own.back} href="/">← explorer</a>
          <WalletProfileButton />
        </div>
      </header>

      <main className={styles.wrap}>
        <section className={own.card}>
          <div className={own.identity}>
            <ProfileAvatarEditor address={profile.address} profile={profile} />

            <div className={own.who}>
              <div className={own.nameRow}>
                <h1>{profile.displayName ?? 'Unnamed holder'}</h1>
                <ProfileEditor address={profile.address} profile={profile} />
              </div>
              <Copyable value={profile.address} />
              {profile.bio && <p className={own.bio}>{profile.bio}</p>}
              {profile.socials.length > 0 && (
                <ul className={own.socials}>
                  {profile.socials.map((s) => (
                    <li key={s.platform}>
                      <span className={own.platform}>{s.platform}</span>
                      <Copyable value={s.handle} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <dl className={own.numbers}>
            <div><dt>Spaces owned</dt><dd>{nf.format(chains.length)}</dd></div>
            <div><dt>Paid transactions</dt><dd>{nf.format(calls)}</dd></div>
            <div><dt>Revenue</dt><dd>{voidAmount(revenue)} <small>VOID</small></dd></div>
          </dl>

        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Execution spaces</h2>
            <span className={styles.note}>read from the deed contract, not from this profile</span>
          </div>
          {chains.length === 0 ? (
            <p className={styles.noHits}>This address holds no deeds.</p>
          ) : (
            <div className={styles.scroller}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>NFT</th>
                    <th>Runtime ID</th>
                    <th className={styles.numCell}>Transactions</th>
                    <th className={styles.numCell}>Apps</th>
                    <th className={styles.numCell}>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {chains.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <a className={styles.chainLink} href={`/?chain=${c.id}#chain-directory`}>
                          {c.name || `VOID Chain #${c.id}`}
                        </a>
                        <div className={styles.chainSub}>Open chain profile · DAO and L3 path</div>
                      </td>
                      <td className={styles.chainId}>
                        <Copyable value={String(c.chainId)} />
                      </td>
                      <td className={styles.numCell}>{nf.format(c.txCount)}</td>
                      <td className={styles.numCell}>{nf.format(c.contractCount)}</td>
                      <td className={styles.numCell}>{voidAmount(c.revenue)} VOID</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
