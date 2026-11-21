// Uploads one file to Supabase Storage with a progress callback (the normal client cannot report progress).
export function uploadWithProgress(opts: {
  bucket: 'videos' | 'thumbnails' | 'avatars';
  path: string;
  file: Blob;
  contentType: string;
  token: string;                       // the signed-in user's access token
  onProgress?: (percent: number) => void;
}): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    const safe = opts.path.split('/').map(encodeURIComponent).join('/');
    xhr.open('POST', `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/${opts.bucket}/${safe}`);
    xhr.setRequestHeader('Authorization', `Bearer ${opts.token}`);
    xhr.setRequestHeader('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { opts.onProgress?.(100); resolve(); return; }
      let message = 'The upload failed.';
      try { message = JSON.parse(xhr.responseText).message || message; } catch { /* keep default */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('The connection dropped. Check your internet and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(opts.file);
  });
  return { promise, abort: () => xhr.abort() };
}
