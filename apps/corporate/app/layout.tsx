import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CompanyGate } from '../components/CompanyGate';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: APP_DISPLAY_NAMES.company,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <CompanyGate>{children}</CompanyGate>
        </Providers>
      </body>
    </html>
  );
}
