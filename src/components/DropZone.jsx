import { useCallback, useRef, useState } from 'react';
import { useLibrary } from '../context/LibraryContext';
import { directoryPickerSupported, handlesSupported, readDrop } from '../lib/handles';

/**
 * Files never leave the machine — `URL.createObjectURL` hands the browser a
 * direct read handle, so a 40GB file opens as fast as a 40MB one.
 *
 * Three ways in, and they are not equivalent:
 *
 *   drop        keeps working exactly as it always did, and quietly yields
 *               `FileSystemFileHandle`s as well where the browser offers them,
 *               so a dropped file can be reopened in a later session
 *   folder      the one worth preferring: one permission covers everything
 *               inside it, now and later
 *   file input  the fallback. It yields no handles at all, so files chosen
 *               this way cannot come back on their own after the tab closes —
 *               which is why it is the third option and not the first.
 */
export default function DropZone({ compact = false }) {
  const { addFiles, addFolder, addViaPicker } = useLibrary();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragging(false);
    // `readDrop` reads the DataTransferItemList before yielding — it is
    // emptied the moment the handler awaits anything.
    const { picks } = await readDrop(e.dataTransfer);
    addFiles(picks);
  }, [addFiles]);

  const browse = useCallback((e) => {
    e.stopPropagation();
    if (handlesSupported) addViaPicker();
    else inputRef.current?.click();
  }, [addViaPicker]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={[
        'rounded-xl border-2 border-dashed transition-colors text-center',
        compact ? 'px-5 py-4' : 'px-8 py-14',
        dragging ? 'border-accent bg-accent/10' : 'border-edge bg-panel/50',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,.mkv,.m4a,.ac3,.eac3,.dts,.opus,.flac,.srt,.vtt,.ass,.ssa"
        className="hidden"
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />

      {compact ? (
        <p className="text-sm text-neutral-400">
          Drop more files,{' '}
          <button type="button" onClick={browse} className="text-white underline hover:text-accent">
            browse
          </button>
          {directoryPickerSupported && (
            <>
              {' or '}
              <button type="button" onClick={() => addFolder()} className="text-white underline hover:text-accent">
                add a folder
              </button>
            </>
          )}
        </p>
      ) : (
        <>
          <p className="text-lg font-medium text-white">Drop video and audio files here</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
            Matching names pair automatically — <code className="text-neutral-300">Movie.mp4</code> with{' '}
            <code className="text-neutral-300">Movie.m4a</code>. Nothing is uploaded anywhere.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {directoryPickerSupported && (
              <button
                type="button"
                onClick={() => addFolder()}
                className="rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-500"
              >
                Add a folder
              </button>
            )}
            <button
              type="button"
              onClick={browse}
              className="rounded-full border border-white/[0.15] bg-white/[0.08] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.16]"
            >
              Choose files
            </button>
          </div>
          {directoryPickerSupported && (
            <p className="mx-auto mt-4 max-w-md text-xs text-neutral-600">
              A folder is worth choosing: the library remembers it, so one click brings
              everything back the next time you open FrenFlix — and anything you add to
              that folder later turns up on its own.
            </p>
          )}
        </>
      )}
    </div>
  );
}
