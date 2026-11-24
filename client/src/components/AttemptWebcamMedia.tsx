import React, { useEffect, useState } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { integrityAPI, WebcamMediaItem } from '../services/api';
import { btn } from './ui';

/**
 * Webcam images/video for one attempt. Nothing loads until the reviewer asks, because
 * opening them is audit-logged; files are fetched with the reviewer's credentials, never
 * through public links.
 */
export default function AttemptWebcamMedia({ attemptId, count, onDeleted }: { attemptId: number; count: number; onDeleted: () => void }) {
  const [items, setItems] = useState<(WebcamMediaItem & { url?: string })[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Release object URLs when closing.
  useEffect(() => () => {
    items?.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
  }, [items]);

  const show = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await integrityAPI.listAttemptMedia(attemptId);
      const loaded = await Promise.all(res.data.media.map(async (item) => {
        try {
          const file = await integrityAPI.getMediaFile(item.id);
          return { ...item, url: URL.createObjectURL(file.data as Blob) };
        } catch (_) {
          return { ...item };
        }
      }));
      setItems(loaded);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not load webcam images.');
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    try {
      await integrityAPI.deleteAttemptMedia(attemptId);
      setItems(null);
      setConfirmDelete(false);
      onDeleted();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not delete webcam data.');
    }
  };

  const expires = items?.find((item) => item.expires_at)?.expires_at;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <Camera className="h-4 w-4 text-violet-600" />
          Webcam ({count})
        </h4>
        <div className="flex gap-2">
          {!items && (
            <button type="button" onClick={show} disabled={loading} className={btn.secondary}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Show webcam images
            </button>
          )}
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className={btn.ghostDanger}>
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          ) : (
            <button type="button" onClick={remove} className={btn.ghostDanger}>
              Confirm: delete all webcam data for this attempt
            </button>
          )}
        </div>
      </div>
      {!items && <p className="text-xs text-gray-500">Opening the images is recorded in the audit log.</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {items && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {items.map((item) => (
              <figure key={item.id} className="overflow-hidden rounded-md border border-gray-200 bg-gray-50">
                {item.url && item.kind === 'snapshot' && <img src={item.url} alt={`Webcam ${new Date(item.client_time || item.created_at).toLocaleTimeString()}`} className="aspect-[4/3] w-full object-cover" />}
                {item.url && item.kind === 'video' && <video src={item.url} controls className="aspect-[4/3] w-full bg-black" />}
                {!item.url && <div className="flex aspect-[4/3] items-center justify-center text-xs text-gray-400">Unavailable</div>}
                <figcaption className="flex items-center justify-between px-1.5 py-0.5 text-[10px] text-gray-600">
                  <span>{new Date(item.client_time || item.created_at).toLocaleTimeString()}</span>
                  {item.reason === 'flag' && <span className="rounded bg-rose-100 px-1 font-semibold text-rose-700">flag</span>}
                </figcaption>
              </figure>
            ))}
          </div>
          {expires && <p className="mt-1 text-xs text-gray-500">Deleted automatically on {new Date(expires).toLocaleDateString()}.</p>}
        </>
      )}
    </div>
  );
}
