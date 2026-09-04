import { redirect } from 'next/navigation';

/** The V4 holder migration is complete; old bookmarks return to the explorer. */
export default function RetiredMigrationRoute() {
  redirect('/');
}
