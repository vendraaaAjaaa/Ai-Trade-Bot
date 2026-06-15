/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.DASHBOARD_API_URL || 'http://localhost:3001',
    NEXT_PUBLIC_DASHBOARD_API_TOKEN: process.env.DASHBOARD_API_TOKEN || '',
  },
};

module.exports = nextConfig;
