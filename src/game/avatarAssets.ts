import { Assets, SCALE_MODES, Sprite, Texture } from "pixi.js";

export interface AvatarDisplayInstance {
  url: string;
  display: Sprite;
}

interface CachedAvatar {
  promise: Promise<AvatarDisplayInstance>;
  refCount: number;
}

const avatarCache = new Map<string, CachedAvatar>();

const canvasCache = new Map<string, string>();

function canvasKeyFromImage(image: HTMLImageElement, originalUrl: string): string | null {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    return null;
  }

  const cached = canvasCache.get(originalUrl);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  try {
    const dataUrl = canvas.toDataURL("image/png", 0.92);
    canvasCache.set(originalUrl, dataUrl);
    return dataUrl;
  } catch (error) {
    console.warn("Failed to convert avatar to data URL", error);
    return null;
  }
}

function sanitiseUrl(url: string): string {
  return url.trim();
}

async function loadSprite(url: string): Promise<AvatarDisplayInstance> {
  const sanitized = sanitiseUrl(url);
  const lower = sanitized.toLowerCase();

  if (lower.startsWith("data:")) {
    const texture = await Assets.load<Texture>(sanitized);
    if (texture.source?.style) {
      texture.source.style.scaleMode = SCALE_MODES.LINEAR;
    }
    const sprite = new Sprite(texture);
    sprite.eventMode = "none";
    sprite.anchor.set(0.5, 0);
    sprite.roundPixels = true;
    return { url: sanitized, display: sprite };
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load avatar image at ${sanitized}`));
    img.src = sanitized;
  });

  const canvasUrl = canvasKeyFromImage(image, sanitized) ?? sanitized;
  const assetConfig = canvasUrl.startsWith("data:")
    ? canvasUrl
    : { src: canvasUrl, data: { crossOrigin: "anonymous" as const } };
  const texture = await Assets.load<Texture>(assetConfig);
  if (texture.source?.style) {
    texture.source.style.scaleMode = SCALE_MODES.LINEAR;
  }

  const sprite = new Sprite(texture);
  sprite.eventMode = "none";
  sprite.anchor.set(0.5, 0);
  sprite.roundPixels = true;

  return { url: sanitized, display: sprite };
}

export async function createAvatarDisplay(url: string): Promise<AvatarDisplayInstance> {
  if (!url) {
    throw new Error("Avatar URL must be provided");
  }

  const sanitized = sanitiseUrl(url);
  const cached = avatarCache.get(sanitized);
  if (cached) {
    cached.refCount += 1;
    return cached.promise;
  }

  const promise = loadSprite(sanitized).then(instance => ({
    url: instance.url,
    display: instance.display,
  }));

  avatarCache.set(sanitized, { promise, refCount: 1 });
  return promise;
}

export function destroyAvatarDisplay(instance: AvatarDisplayInstance | null | undefined): void {
  if (!instance) {
    return;
  }

  const sanitized = sanitiseUrl(instance.url);
  const cached = avatarCache.get(sanitized);
  if (!cached) {
    try {
      instance.display.destroy({ children: true, texture: true, baseTexture: true });
    } catch {
      /* ignore */
    }
    return;
  }

  cached.refCount -= 1;
  if (cached.refCount > 0) {
    return;
  }

  avatarCache.delete(sanitized);
  try {
    instance.display.destroy({ children: true, texture: true, baseTexture: true });
  } catch {
    /* ignore */
  }
  void Assets.unload(sanitized).catch(() => undefined);
  canvasCache.delete(sanitized);
}
