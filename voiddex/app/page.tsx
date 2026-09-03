export default function Page() {
  return <main className="shell">
    <header className="top"><a className="brand" href="https://voidscan-nu.vercel.app">VOID<b>DEX</b></a></header>
    <section className="hero"><div><div className="tag">VOID CHAIN #1 · V4</div><h1>V4 pools are<br /><b>live.</b></h1><p>The previous V2 interface remains offline. The V4 pools now use the factory gateway and signature-only VOID execution; the new trading interface is being connected to these verified pools.</p></div><aside className="fee"><span className="label">Execution policy</span><strong>VOID only</strong><small>No wallet ETH transaction is available for V4 app actions.</small></aside></section>
    <footer className="foot"><a href="https://voidscan-nu.vercel.app">Open VoidScan →</a></footer>
  </main>;
}
