import { redirect } from 'next/navigation';

/**
 * Execution lives on VoidDEX. Keeping a second, wallet-transaction DEX inside
 * VoidScan would let users take an unintended direct ETH-gas route by mistake.
 */
export default function ChainOneDexRedirect() {
  redirect('https://voiddex.voidshub.com');
}
