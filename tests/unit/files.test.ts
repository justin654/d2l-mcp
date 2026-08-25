import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/auth.js', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  getAuthenticatedContext: vi.fn(),
}));

import { downloadFile } from '../../src/tools/files.js';
import { getAuthenticatedContext } from '../../src/auth.js';

describe('downloadFile', () => {
  let outputDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    outputDir = mkdtempSync(join(tmpdir(), 'd2l-mcp-files-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('downloads a content topic through the authenticated file API', async () => {
    const data = Buffer.from('%PDF-1.7 test');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(data, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename*=UTF-8''lecture%20one.pdf",
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadFile('/content/enforced/course/fallback.pdf', outputDir, 123, 456);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/d2l/api/le/1.57/123/content/topics/456/file'),
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(getAuthenticatedContext).not.toHaveBeenCalled();
    expect(result.filename).toBe('lecture one.pdf');
    expect(readFileSync(result.path)).toEqual(data);
  });

  it('requires orgUnitId and topicId to be provided together', async () => {
    await expect(
      downloadFile('/content/enforced/course/file.pdf', outputDir, 123)
    ).rejects.toThrow('orgUnitId and topicId must be provided together');
  });

  it('rejects a login redirect instead of saving it as a course file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://learn.ul.ie/d2l/login?sessionExpired=1',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => Buffer.from('<html>Login</html>'),
    }));

    await expect(
      downloadFile('/content/enforced/course/file.pdf', outputDir, 123, 456)
    ).rejects.toThrow('Brightspace returned an HTML login page');
  });
});
