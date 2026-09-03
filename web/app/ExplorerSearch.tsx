'use client';

import { FormEvent, useState } from 'react';
import styles from './page.module.css';

/** The header and the registry share one search intent without making the
 * server-rendered explorer client-side. The directory listens for this event. */
export function ExplorerSearch() {
  const [value, setValue] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = value.trim();
    window.location.hash = 'chain-directory';
    window.dispatchEvent(new CustomEvent('voidscan:search', { detail: query }));
  }

  return (
    <form className={styles.search} onSubmit={submit} role="search">
      <svg className={styles.searchIcon} width="13" height="13" viewBox="0 0 16 16" fill="none"
           stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)}
             placeholder="Search a deed, runtime ID, or holder" aria-label="Search the registry" />
      <kbd>↵</kbd>
    </form>
  );
}
