import { useCallback, useRef, useState } from 'react';
import { useLibrary } from '../context/LibraryContext';

/**
 * Files never leave the machine — `URL.createObjectURL` hands the browser a
 * direct read handle, so a 40GB file opens as fast as a 40MB one.
 */
export default function DropZone({ compact = false }) {
  const { addFiles } = useLibrary();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      className={[
        'cursor-pointer rounded-xl border-2 border-dashed transition-colors text-center',
        compact ? 'px-5 py-4' : 'px-8 py-16',
        dragging ? 'border-accent bg-accent/10' : 'border-edge hover:border-neutral-500 bg-panel/50',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,.mkv,.m4a,.ac3,.eac3,.dts,.opus,.flac"
        className="hidden"
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />
      {compact ? (
        <p className="text-sm text-neutral-400">
          Drop more files, or <span className="text-white underline">browse</span>
        </p>
      ) : (
        <>
          <p className="text-lg font-medium text-white">Drop video and audio files here</p>
          <p className="mt-2 text-sm text-neutral-400">
            Matching names pair automatically — <code className="text-neutral-300">Movie.mp4</code> with{' '}
            <code className="text-neutral-300">Movie.m4a</code>. Nothing is uploaded anywhere.
          </p>
        </>
      )}
    </div>
  );
}
