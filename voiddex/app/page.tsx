export default function Page() {
  return <main className="shell">
    <header className="top"><a className="brand" href="https://voidscan-nu.vercel.app">VOID<b>DEX</b></a></header>
    <section className="hero">
      <div>
        <div className="tag">VOID CHAIN #1 · V3 MIGRATION</div>
        <h1>Trading is<br /><b>being rebuilt.</b></h1>
        <p>The V2 DEX is not available through this interface. Chain #1 is now on the mandatory VOID-only runtime; the new pools will be published through the V3 app factory and relayed by signed VOID requests only.</p>
      </div>
      <aside className="fee"><span className="label">Execution policy</span><strong>VOID only</strong><small>No wallet transaction with ETH gas will be offered by the V3 DEX.</small></aside>
    </section>
    <footer className="foot"><a href="https://voidscan-nu.vercel.app">Open VoidScan →</a></footer>
  </main>;
}
