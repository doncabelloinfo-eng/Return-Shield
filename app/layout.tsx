import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Return Shield',
  description: 'Every parcel sitting in a post office, and what to do about it today.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The theme is a cookie rather than a client-side flash: the panel is opened
  // first thing in the morning and a white flash in a dark room is a real cost.
  const theme = cookies().get('rs_theme')?.value === 'dark' ? 'dark' : 'light';

  return (
    <html lang="en" data-theme={theme}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
