import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserContext } from 'playwright';
import { getAuthenticatedContext, getToken } from '../auth.js';
import { API_VERSION } from '../client.js';
import mammoth from 'mammoth';

const D2L_HOST = process.env.D2L_HOST || 'learn.ul.ie';

// Extract text content from various file types
async function extractContent(data: Buffer, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase();
  
  // Text-based files - return as string
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h'].includes(lowerExt)) {
    return data.toString('utf-8');
  }
  
  // Word documents - extract text with mammoth
  if (lowerExt === '.docx') {
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      return result.value;
    } catch {
      return null;
    }
  }
  
  // For binary files, return null (could add base64 option later)
  return null;
}

export async function downloadFile(
  url: string,
  savePath?: string,
  orgUnitId?: number,
  topicId?: number
) {
  if ((orgUnitId === undefined) !== (topicId === undefined)) {
    throw new Error('orgUnitId and topicId must be provided together');
  }

  // Ensure full URL
  const fullUrl = url.startsWith('http') ? url : `https://${D2L_HOST}${url}`;
  const useTopicFileApi = orgUnitId !== undefined && topicId !== undefined;
  const downloadUrl = useTopicFileApi
    ? `https://${D2L_HOST}/d2l/api/le/${API_VERSION}/${orgUnitId}/content/topics/${topicId}/file`
    : fullUrl;

  // Extract filename from URL
  const urlPath = new URL(fullUrl).pathname;
  const pathParts = urlPath.split('/');
  const urlFilename = decodeURIComponent(pathParts[pathParts.length - 1] || 'download');

  let browser: BrowserContext | null = null;

  try {
    let data: Buffer;
    let contentType: string;
    let contentDisposition: string;
    let responseUrl: string;

    if (useTopicFileApi) {
      const token = await getToken();
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }

      data = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get('content-type') || 'application/octet-stream';
      contentDisposition = response.headers.get('content-disposition') || '';
      responseUrl = response.url;
    } else {
      browser = await getAuthenticatedContext();
      const page = await browser.newPage();
      const response = await page.request.get(fullUrl);

      if (!response.ok()) {
        throw new Error(`Failed to download file: ${response.status()} ${response.statusText()}`);
      }

      data = await response.body();
      contentType = response.headers()['content-type'] || 'application/octet-stream';
      contentDisposition = response.headers()['content-disposition'] || '';
      responseUrl = response.url();
    }

    // Brightspace can redirect a failed file request to a 200 login page.
    if (
      responseUrl.includes('/d2l/login') ||
      (!useTopicFileApi &&
        contentType.toLowerCase().includes('text/html') &&
        !url.toLowerCase().endsWith('.html'))
    ) {
      throw new Error('Brightspace returned an HTML login page instead of the course file');
    }

    // Extract filename from content-disposition or use URL filename
    let filename = urlFilename;
    const extendedFilenameMatch = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;\n]+)/i);
    const filenameMatch = contentDisposition.match(/filename\s*=\s*((['"]).*?\2|[^;\n]+)/i);
    if (extendedFilenameMatch) {
      filename = decodeURIComponent(extendedFilenameMatch[1].trim());
    } else if (filenameMatch) {
      filename = filenameMatch[1].replace(/["']/g, '').trim();
    }

    // Determine where to save
    const downloadsDir = savePath && fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()
      ? savePath
      : path.join(os.homedir(), 'Downloads');

    let finalPath = savePath && fs.existsSync(savePath) && !fs.statSync(savePath).isDirectory()
      ? savePath
      : path.join(downloadsDir, filename);

    // Handle filename collisions
    let counter = 1;
    const ext = path.extname(finalPath);
    const base = path.basename(finalPath, ext);
    const dirPath = path.dirname(finalPath);

    while (fs.existsSync(finalPath)) {
      finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
      counter++;
    }

    // Write file
    fs.writeFileSync(finalPath, data);

    // Determine mime type from extension if content-type is generic
    const extToMime: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.zip': 'application/zip',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
    };

    const finalContentType = contentType.includes('octet-stream')
      ? (extToMime[ext.toLowerCase()] || contentType)
      : contentType;

    // Extract text content for supported file types
    const textContent = await extractContent(data, ext);

    return {
      path: finalPath,
      filename: path.basename(finalPath),
      size: data.length,
      contentType: finalContentType,
      content: textContent,
    };
  } finally {
    await browser?.close();
  }
}
