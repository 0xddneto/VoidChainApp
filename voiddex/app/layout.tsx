import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'VOIDDEX', description: 'Uniswap V2 pools inside VOID Chain #1' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
