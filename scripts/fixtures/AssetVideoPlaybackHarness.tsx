import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetVideoPlayerDialog } from '../../src/components/AssetVideoPlayerDialog';
import type { ReferenceAsset } from '../../src/types';

function Harness() {
  const [asset, setAsset] = useState<ReferenceAsset>();
  (window as any).qaOpenVideo = (file: string) => setAsset({ id: file, name: file, type: 'video', mediaType: 'video', role: 'motion', source: 'uploaded', tags: [],
    url: `lianhua-asset://local/video/${encodeURIComponent(file)}`, relativePath: `video/${file}`, createdAt: 1, updatedAt: 1 });
  (window as any).qaCloseVideo = () => setAsset(undefined);
  return <>{asset && <AssetVideoPlayerDialog key={asset.id} asset={asset} onClose={() => setAsset(undefined)} onMetadata={(metadata) => {
    (window as any).qaMetadata = metadata;
    setAsset((value) => value && { ...value, ...metadata });
  }} />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
