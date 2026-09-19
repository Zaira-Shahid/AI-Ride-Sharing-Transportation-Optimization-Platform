import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Sidebar } from '../components/Sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: APP_DISPLAY_NAMES.admin,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
