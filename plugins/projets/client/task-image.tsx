/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Image dialog actions. */
import { useEffect, useRef, useState } from "react";

export interface TaskImage {
  id: number;
  file: File;
}

export function ImageTile({ image, remove }: { image: TaskImage; remove(): void }) {
  const [url, setUrl] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const src = URL.createObjectURL(image.file);
    setUrl(src);
    return () => URL.revokeObjectURL(src);
  }, [image.file]);
  if (!url) return null;
  return (
    <div className="lp-image">
      <button
        type="button"
        aria-label={"Agrandir " + image.file.name}
        onClick={() => dialog.current?.showModal()}
      >
        <img src={url} alt={image.file.name} />
      </button>
      <button
        className="lp-remove"
        type="button"
        aria-label={"Retirer " + image.file.name}
        onClick={remove}
      >
        ×
      </button>
      <dialog ref={dialog} className="lp-lightbox" aria-label={image.file.name}>
        <img src={url} alt={image.file.name} />
        <button type="button" onClick={() => dialog.current?.close()}>
          Fermer
        </button>
      </dialog>
    </div>
  );
}
