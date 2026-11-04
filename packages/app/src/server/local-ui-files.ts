import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Resolve a regular UI asset, including SPA fallback, without escaping its root. */
export function localUiFile(directory: string, rawUrl: string): { path: string; size: number } | undefined {
  try {
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return;
    const root = realpathSync(directory);
    const pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!inside(root, candidate)) return;
    let actual: string;
    try { actual = realpathSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      actual = realpathSync(resolve(root, 'index.html'));
    }
    if (!inside(root, actual)) return;
    const stat = statSync(actual);
    return stat.isFile() ? { path: actual, size: stat.size } : undefined;
  } catch { return; }
}
