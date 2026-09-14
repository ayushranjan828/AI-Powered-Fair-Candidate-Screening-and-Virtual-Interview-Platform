import { useCallback, useRef, useState } from "react";

import { ALLOWED_EXT } from "../lib/constants.js";
import { bytes } from "../lib/format.js";

/**
 * Recursively collects every file under a dropped directory entry.
 * Dropping a folder only gives us a DirectoryEntry, so we walk it ourselves.
 */
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (f) => {
          // Stash the path we walked; File.webkitRelativePath is empty here.
          f._rel = prefix + entry.name;
          out.push(f);
          resolve();
        },
        () => resolve(),
      );
      return;
    }
    if (!entry.isDirectory) return resolve();

    const reader = entry.createReader();
    // readEntries only returns a batch at a time — keep asking until it is empty.
    const readBatch = () =>
      reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
        readBatch();
      }, resolve);
    readBatch();
  });
}

const MAX_LISTED = 400;

export default function Dropzone({ files, onAdd, onRemove, onClear }) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const zipInput = useRef(null);

  const onDrop = useCallback(
    async (e) => {
      e.preventDefault();
      setDragging(false);

      const items = [...(e.dataTransfer.items || [])];
      const entries = items
        .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
        .filter(Boolean);

      if (entries.length) {
        const collected = [];
        for (const entry of entries) await walkEntry(entry, "", collected);
        onAdd(collected);
      } else {
        onAdd([...e.dataTransfer.files]);
      }
    },
    [onAdd],
  );

  const pick = (ref) => (e) => {
    onAdd([...e.target.files]);
    e.target.value = ""; // re-picking the same file must fire change again
    void ref;
  };

  const shown = files.slice(0, MAX_LISTED);

  return (
    <>
      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="dz-icon" aria-hidden="true">
          ⬆
        </div>
        <p className="dz-main">
          <strong>Drag &amp; drop</strong> resumes, folders or ZIP archives
        </p>
        <div className="dz-buttons">
          <button type="button" className="btn btn-ghost" onClick={() => fileInput.current?.click()}>
            Select files
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => folderInput.current?.click()}
          >
            Select folder
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => zipInput.current?.click()}>
            Select ZIP
          </button>
        </div>
        <p className="dz-note">PDF · DOC · DOCX · RTF · TXT · ZIP — nested folders supported</p>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept=".pdf,.doc,.docx,.docm,.rtf,.txt,.zip"
        onChange={pick(fileInput)}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        webkitdirectory=""
        directory=""
        onChange={pick(folderInput)}
      />
      <input
        ref={zipInput}
        type="file"
        multiple
        hidden
        accept=".zip"
        onChange={pick(zipInput)}
      />

      <div className="filelist-head">
        <strong>
          {files.length} file{files.length === 1 ? "" : "s"} queued
        </strong>
        {files.length > 0 && (
          <button type="button" className="btn btn-link" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>

      <ul className="filelist">
        {shown.map((f, i) => (
          <li key={`${f.rel}-${f.file.size}-${i}`}>
            <span title={f.rel}>{f.rel}</span>
            <span className="fsize">
              {bytes(f.file.size)}
              <button
                type="button"
                className="btn btn-link"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${f.rel}`}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
        {files.length > MAX_LISTED && (
          <li>
            <em>…and {files.length - MAX_LISTED} more</em>
          </li>
        )}
      </ul>
    </>
  );
}

/** Filters and de-duplicates an incoming batch against what is already queued. */
export function mergeFiles(existing, incoming) {
  const next = [...existing];
  let skipped = 0;

  for (const f of incoming) {
    const rel = f._rel || f.webkitRelativePath || f.name;
    if (!ALLOWED_EXT.test(rel)) {
      skipped++;
      continue;
    }
    if (next.some((x) => x.rel === rel && x.file.size === f.size)) continue;
    next.push({ file: f, rel });
  }

  return { files: next, skipped };
}
