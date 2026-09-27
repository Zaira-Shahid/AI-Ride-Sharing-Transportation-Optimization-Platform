import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGate } from '../components/AuthGate';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: APP_DISPLAY_NAMES.admin,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">
        <Providers>
          <AuthGate>{children}</AuthGate>
        </Providers>
      </body>
    </html>
  );
}
