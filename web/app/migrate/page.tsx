import { redirect } from 'next/navigation';

/** Retired migration bookmarks return to the canonical explorer. */
export default function RetiredMigrationRoute() {
  redirect('/');
}
