import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hub CRM",
  description: "Hub CRM",
  robots: { index: false, follow: false },
  icons: { icon: { url: "/legacy/assets/images/favicon_voltronix.png", type: "image/png", sizes: "65x65" } },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Preserve the canonical PHP stylesheet order with unchanged local assets.
  const styles = ["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css", "select2.min.css"];
  return <html lang="en"><head>{styles.map((file) =>
    <link key={file} rel="stylesheet" href={`/legacy/assets/css/${file}`} />
  )}</head><body data-pc-preset="preset-1" data-pc-sidebar-caption="true" data-pc-direction="ltr" data-pc-theme="light">{children}</body></html>;
}
