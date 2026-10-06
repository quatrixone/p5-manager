// Upload files picked on the device running the browser to
// PUT /api/convert/upload (one request per file, raw body). XHR instead of
// fetch because only XHR reports upload progress.

// <input type="file"> → [{ file, rel }]. Folder pickers (webkitdirectory)
// expose the path inside the picked folder, including its own name.
export function entriesFromInput(fileList) {
  return Array.from(fileList || []).map(file => ({ file, rel: file.webkitRelativePath || file.name }));
}

// Names the upload creates directly in the destination folder.
export function topLevelNames(entries) {
  return Array.from(new Set(entries.map(e => e.rel.split('/')[0])));
}

// dest: { kind: 'local' | 'ftp', path, ip? }
export function uploadOne({ file, rel, dest, overwrite, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ kind: dest.kind, path: dest.path, rel });
    if (dest.ip) qs.set('ip', dest.ip);
    if (overwrite) qs.set('overwrite', '1');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/convert/upload?${qs}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data?.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Connection lost during upload'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}
