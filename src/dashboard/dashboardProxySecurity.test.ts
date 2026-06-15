import fs from 'fs';
import path from 'path';

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('dashboard proxy security', () => {
  it('does not expose the dashboard bearer token through NEXT_PUBLIC env usage', () => {
    const forbiddenPublicTokenName = ['NEXT_PUBLIC', 'DASHBOARD_API_TOKEN'].join('_');
    const files = [
      'dashboard/lib/apiClient.ts',
      'dashboard/next.config.js',
      'dashboard/pages/api/backend/[...path].ts',
    ].map(readRepoFile).join('\n');

    expect(files.includes(forbiddenPublicTokenName)).toBe(false);
  });

  it('keeps browser API calls relative to the server-side proxy', () => {
    const apiClient = readRepoFile('dashboard/lib/apiClient.ts');

    expect(apiClient.includes("baseURL: '/api/backend'")).toBe(true);
    expect(apiClient.includes('Authorization')).toBe(false);
    expect(apiClient.includes('DASHBOARD_API_TOKEN')).toBe(false);
  });

  it('injects the backend bearer token only inside the dashboard server proxy', () => {
    const proxy = readRepoFile('dashboard/pages/api/backend/[...path].ts');

    expect(proxy.includes("process.env['BACKEND_API_TOKEN']")).toBe(true);
    expect(proxy.includes("process.env['DASHBOARD_API_TOKEN']")).toBe(true);
    expect(proxy.includes('BACKEND_PROXY_ROUTES')).toBe(true);
    expect(proxy.includes('new URL(backendPath')).toBe(true);
  });
});
