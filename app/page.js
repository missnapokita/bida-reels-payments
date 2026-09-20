const plans = [
  ["1 Week", "₱29"],
  ["1 Month", "₱79"],
  ["3 Months", "₱199"],
  ["1 Year", "₱599"]
];

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ width: "100%", maxWidth: 520, background: "#171717", border: "1px solid #333", borderRadius: 24, padding: 28 }}>
        <h1 style={{ margin: 0, fontSize: 34 }}>Bida <span style={{ color: "#ffae00" }}>Reels</span></h1>
        <p style={{ color: "#aaa", lineHeight: 1.6 }}>Secure VIP payment service is online.</p>
        <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
          {plans.map(([name, price]) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: 14, borderRadius: 14, background: "#222" }}>
              <span>{name}</span><strong style={{ color: "#ffc21c" }}>{price}</strong>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
