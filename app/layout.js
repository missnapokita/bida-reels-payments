export const metadata = {
  title: "Bida Reels Payments",
  description: "Secure payment service for Bida Reels VIP"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#090909", color: "#fff", fontFamily: "Arial, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
