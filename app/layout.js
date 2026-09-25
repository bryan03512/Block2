import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "study_buddy.sh",
  description: "Ask an AI assistant questions about your course material.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#05070a]">
        <nav className="sticky top-0 z-10 border-b border-[#1c3a1c] bg-[#0b0f0c]/90 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3 text-sm">
            <span className="font-semibold text-[#39ff14]">VCS AI Program</span>
            <div className="flex gap-5 font-medium text-[#6b8f6b]">
              <Link href="/" className="transition hover:text-[#39ff14]">
                ./study_buddy.sh
              </Link>
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
