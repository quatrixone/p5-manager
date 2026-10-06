import { useState } from 'react';
import FolderPickerModal from './FolderPickerModal';

// The one way to choose a path on the server's disk: a "Browse" button that
// opens the folder/file picker, and - as PathField - the text input next to
// it. Every screen that asks for a server path uses these, so the button
// looks and behaves the same everywhere.

const dirOf = (p) => p.replace(/[^/]+$/, '') || '/';

// Where the picker opens: an explicit `browsePath`, else next to the current
// value (its folder when picking files), else `fallbackPath`.
function startPath({ value, browsePath, selectFiles, fallbackPath }) {
  if (browsePath) return browsePath;
  if (value && value.startsWith('/')) return selectFiles ? dirOf(value) : value;
  return fallbackPath;
}

// Button + picker without an input, for places that already render their own
// path box (the file browser's address bar).
//   value         current path, used to decide where the picker opens
//   onPick(path)  called with the chosen absolute path
//   selectFiles   pick a file instead of a folder
//   fileFilter    (name) => boolean, greys out other files
//   compact       icon-only button for tight rows
export function BrowseButton({
  value = '', onPick, selectFiles = false, fileFilter, browsePath,
  fallbackPath = '/mnt', compact = false, small = false, disabled = false,
  title, pickerTitle,
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`btn btn-secondary ${small ? 'btn-sm' : ''}`}
        style={{ flexShrink: 0 }}
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={title || (selectFiles ? 'Browse for a file' : 'Browse for a folder')}
      >
        {compact ? '📁' : '📁 Browse…'}
      </button>
      {open && (
        <FolderPickerModal
          open
          onClose={() => setOpen(false)}
          onPick={onPick}
          initialPath={startPath({ value, browsePath, selectFiles, fallbackPath })}
          selectFiles={selectFiles}
          fileFilter={fileFilter}
          title={pickerTitle || (selectFiles ? 'Pick file' : 'Pick folder')}
        />
      )}
    </>
  );
}

// Text input + Browse button. `onChange` receives the path string, both when
// typed and when picked.
export default function PathField({
  value, onChange, placeholder, inputStyle, inputClassName = 'input flex-1',
  browseTitle, ...browse
}) {
  return (
    <div className="flex gap-xs items-center" style={{ minWidth: 0 }}>
      <input
        className={inputClassName}
        style={inputStyle}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <BrowseButton value={value} onPick={onChange} title={browseTitle} {...browse} />
    </div>
  );
}
