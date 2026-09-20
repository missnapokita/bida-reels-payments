function safeOrder(value) {
  const order = String(value || "");
  return /^[a-zA-Z0-9-]{10,80}$/.test(order) ? order : "";
}

export default async function PaymentResult({ searchParams }) {
  const params = await searchParams;
  const status = params?.status === "success" ? "success" : "cancelled";
  const order = safeOrder(params?.order);
  const query = `status=${encodeURIComponent(status)}&order=${encodeURIComponent(order)}`;
  const appUrl = `bidareels://payment?${query}`;
  const intentUrl = `intent://payment?${query}`
    + "#Intent;scheme=bidareels;package=com.bidareels.ph;end";
  const success = status === "success";

  return (
    <main style={{
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 24,
      color: "#fff",
      background: "radial-gradient(circle at top, #38210d 0, #0b0b0b 42%, #050505 100%)",
      textAlign: "center"
    }}>
      <section style={{ maxWidth: 480 }}>
        <div style={{ color: success ? "#ffd21f" : "#ff9400", fontSize: 54 }}>
          {success ? "✓" : "×"}
        </div>
        <h1>{success ? "Payment received" : "Payment cancelled"}</h1>
        <p style={{ color: "#aaa", lineHeight: 1.6 }}>
          {success
            ? "Returning to Bida Reels to verify and activate your VIP membership."
            : "No VIP time was added. You can return to Bida Reels and try again."}
        </p>
        <a href={appUrl} style={{
          display: "inline-block",
          marginTop: 18,
          padding: "14px 24px",
          borderRadius: 999,
          color: "#1d1200",
          background: "linear-gradient(90deg, #ffd21f, #ff9400)",
          fontWeight: 800,
          textDecoration: "none"
        }}>
          Return to Bida Reels
        </a>
        <script dangerouslySetInnerHTML={{
          __html: `setTimeout(function(){window.location.href=${JSON.stringify(intentUrl)};},500);`
        }} />
      </section>
    </main>
  );
}
