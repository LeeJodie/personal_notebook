import type { Metadata } from "next";
import "./globals.css";

// Keep metadata request-independent. Vinext's local worker runner evaluates
// metadata before a request context exists, so calling `headers()` here makes
// the whole local app return HTTP 500. Relative image URLs are resolved by the
// active deployment origin (localhost, a share host, or the production host).
export const metadata: Metadata = {
  title: "声阅 · 智能文档阅读",
  description: "将网页与文档转换为可阅读、可朗读、可检索的 H5 阅读页。",
  openGraph: {
    title: "声阅 · 智能文档阅读",
    description: "将网页与文档转换为可阅读、可朗读、可检索的 H5 阅读页。",
    type: "website",
    images: [{ url: "/og.png", width: 1733, height: 909, alt: "声阅：把任何资料变成会朗读的网页" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "声阅 · 智能文档阅读",
    description: "将网页与文档转换为可阅读、可朗读、可检索的 H5 阅读页。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
