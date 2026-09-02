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
        </div>
      </header>

      <main className={styles.wrap}>
        <section className={own.card}>
          <div className={own.identity}>
            {profile.avatarUri ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={own.avatar} src={profile.avatarUri} alt="" />
            ) : (
              <div className={`${own.avatar} ${own.avatarBlank}`} aria-hidden="true" />
            )}

            <div className={own.who}>
              <h1>{profile.displayName ?? 'Unnamed holder'}</h1>
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
            <div><dt>Chains owned</dt><dd>{nf.format(chains.length)}</dd></div>
            <div><dt>Calls charged</dt><dd>{nf.format(calls)}</dd></div>
            <div><dt>Revenue</dt><dd>{voidAmount(revenue)} <small>VOID</small></dd></div>
          </dl>

          <ProfileEditor address={profile.address} profile={profile} />
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Chains</h2>
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
                    <th>Chain ID</th>
                    <th className={styles.numCell}>Calls</th>
                    <th className={styles.numCell}>Apps</th>
                    <th className={styles.numCell}>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {chains.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className={styles.chainName}>VOID Chain #{c.id}</div>
                        <div className={styles.chainSub}>{c.name ?? 'no name set'}</div>
                      </td>
                      <td className={styles.chainId}>
                        <Copyable value={String(c.chainId)} />
                      </td>
                      <td className={styles.numCell}>{nf.format(c.txCount)}</td>
                      <td className={styles.numCell}>{nf.format(c.contractCount)}</td>
                      <td className={styles.numCell}>{voidAmount(c.revenue)}</td>
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
