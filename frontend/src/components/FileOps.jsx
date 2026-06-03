import { useState } from 'react';
import MicroMount from './MicroMount';
import Downloader from './Downloader';
import Queue from './Queue';
import FileBrowser from './FileBrowser';

export default function FileOps({ profiles, onNotification }) {
  const [subTab, setSubTab] = useState('files');

  return (
    <div className="flex-col gap-md">
      <div className="tabs">
        <button className={`tab-item ${subTab === 'files' ? 'active' : ''}`} onClick={() => setSubTab('files')}>📁 Files</button>
        <button className={`tab-item ${subTab === 'convert' ? 'active' : ''}`} onClick={() => setSubTab('convert')}>🔄 Convert</button>
        <button className={`tab-item ${subTab === 'download' ? 'active' : ''}`} onClick={() => setSubTab('download')}>⬇️ Download</button>
        <button className={`tab-item ${subTab === 'queue' ? 'active' : ''}`} onClick={() => setSubTab('queue')}>📋 Queue</button>
      </div>

      {subTab === 'files' && (
        <FileBrowser profiles={profiles} onNotification={onNotification} enableFtp enableExtract enableDelete enableFtpUpload />
      )}
      {subTab === 'convert' && (
        <MicroMount profiles={profiles} onNotification={onNotification} />
      )}
      {subTab === 'download' && (
        <Downloader profiles={profiles} onNotification={onNotification} />
      )}
      {subTab === 'queue' && <Queue />}
    </div>
  );
}