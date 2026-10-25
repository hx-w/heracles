import { useId, useRef, useState } from 'react';
import type { MessageImage } from '../types';
import './reply-images.css';

function localImageUrl(image: MessageImage): string | null {
  if (typeof image.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(image.id)) return null;
  if (image.url !== `/api/images/${image.id}`) return null;
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) return null;
  return image.url;
}

function ReplyImage({ image }: { image: MessageImage }) {
  const url = localImageUrl(image);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const captionId = useId();


  function close() {
    dialogRef.current?.close();
    setOpen(false);
  }

  const unavailable = !url || failed;
  return <figure className="reply-image" data-image-id={image.id}>
    {unavailable ? <p className="reply-image-error" role="status">示意图加载失败，请刷新后重试。文字回复仍可阅读。</p>
      : <button ref={triggerRef} type="button" className="reply-image-trigger" aria-label={`查看示意图：${image.title}`} aria-haspopup="dialog" onClick={() => {
        setOpen(true);
        dialogRef.current?.showModal();
      }}>
        <img src={url!} alt={image.title} width={image.width} height={image.height} onError={() => setFailed(true)} />
      </button>}
    <figcaption className="reply-image-caption"><span className="reply-image-label">生成示意图</span>{image.caption && <span>{image.caption}</span>}</figcaption>
    <dialog ref={dialogRef} className="reply-image-detail" aria-labelledby={titleId} aria-describedby={captionId} onClose={() => {
      if (dialogRef.current?.open) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }}>
      {open && <>
        <header className="reply-image-detail-header">
          <h2 id={titleId}>{image.title}</h2>
          <button type="button" className="quiet" autoFocus onClick={close} aria-label="关闭示意图详情">关闭</button>
        </header>
        <div className="reply-image-detail-body">
          {!unavailable ? <img src={url!} alt={image.title} width={image.width} height={image.height} onError={() => setFailed(true)} />
            : <p className="reply-image-error" role="status">示意图加载失败。文字回复仍可阅读。</p>}
          <p id={captionId} className="reply-image-caption"><span className="reply-image-label">生成示意图</span>{image.caption && <span>{image.caption}</span>}</p>
          <p className="reply-image-attribution">生成来源：{image.provider} · {image.model}。示意图不是实测数据。</p>
          {!unavailable && <a className="reply-image-original" href={url!} target="_blank" rel="noopener noreferrer">查看原图，可在浏览器中放大<span className="sr-only">，在新标签页打开</span></a>}
        </div>
      </>}
    </dialog>
  </figure>;
}

export function ReplyImages({ images, error }: { images: MessageImage[]; error?: string | null }) {
  return <>
    {images.map(image => <ReplyImage key={image.id} image={image} />)}
    {error && <p className="reply-image-error" role="status">{error}</p>}
  </>;
}
