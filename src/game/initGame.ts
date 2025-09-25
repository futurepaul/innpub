import {
  type Application,
  Assets,
  Container,
  Rectangle,
  Sprite,
  Texture,
  SCALE_MODES,
  type Ticker,
} from "pixi.js";
import { XMLParser } from "fast-xml-parser";

type TileLayer = {
  name: string;
  tiles: number[];
};

type CollisionBox = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TilesetInfo = {
  firstGid: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
  imageSource: string;
  imageUrl: string;
};

type TiledMap = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  layers: TileLayer[];
  collisions: CollisionBox[];
  tileset: TilesetInfo;
};

type RawLayer = {
  name: string;
  width: number;
  height: number;
  data?: {
    "#text"?: string;
    encoding?: string;
  };
};

type RawTilesetRef = {
  firstgid: number;
  source: string;
};

type RawObjectGroup = {
  name: string;
  object?: RawCollision | RawCollision[];
};

type RawCollision = {
  id?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  parseAttributeValue: true,
});

const WHITE_TEXTURE = Texture.WHITE;

export async function initGame(app: Application): Promise<() => void> {
  const mapUrl = new URL("/map/innpub-interior.tmx", window.location.origin).href;
  const map = await loadTiledMap(mapUrl);

  const scene = new Container();
  scene.eventMode = "none";
  app.stage.addChild(scene);

  const mapPixelWidth = map.width * map.tileWidth;
  const mapPixelHeight = map.height * map.tileHeight;

  let tilesheetTexture: Texture | undefined;
  try {
    tilesheetTexture = await Assets.load<Texture>(map.tileset.imageUrl);
    tilesheetTexture.source.style.scaleMode = SCALE_MODES.NEAREST;
  } catch (error) {
    console.warn("Falling back to debug colours; failed to load tileset image", error);
  }

  const tileTextureCache = new Map<number, Texture>();
  const getTileTexture = (gid: number): Texture => {
    if (!tilesheetTexture) {
      return WHITE_TEXTURE;
    }

    const existing = tileTextureCache.get(gid);
    if (existing) {
      return existing;
    }

    const localId = gid - map.tileset.firstGid;
    if (localId < 0) {
      return WHITE_TEXTURE;
    }

    const columns = map.tileset.columns || Math.max(1, Math.floor(tilesheetTexture.width / map.tileset.tileWidth));
    const xIndex = localId % columns;
    const yIndex = Math.floor(localId / columns);

    const frame = new Rectangle(
      xIndex * map.tileset.tileWidth,
      yIndex * map.tileset.tileHeight,
      map.tileset.tileWidth,
      map.tileset.tileHeight,
    );

    const subTexture = new Texture({
      source: tilesheetTexture.source,
      frame,
    });
    subTexture.label = `tile-${gid}`;

    tileTextureCache.set(gid, subTexture);
    return subTexture;
  };

  const hashTint = (gid: number) => {
    const seed = (gid * 2654435761) >>> 0;
    const r = 0x40 + (seed & 0x3f);
    const g = 0x40 + ((seed >> 6) & 0x3f);
    const b = 0x40 + ((seed >> 12) & 0x3f);
    return (r << 16) | (g << 8) | b;
  };

  for (const layer of map.layers) {
    const layerContainer = new Container();
    layerContainer.eventMode = "none";
    layerContainer.label = layer.name;
    scene.addChild(layerContainer);

    layer.tiles.forEach((gid, index) => {
      if (!gid) {
        return;
      }

      const column = index % map.width;
      const row = Math.floor(index / map.width);

      const sprite = new Sprite(getTileTexture(gid));
      sprite.eventMode = "none";
       sprite.roundPixels = true;
      sprite.x = column * map.tileWidth;
      sprite.y = row * map.tileHeight;

      if (!tilesheetTexture) {
        sprite.width = map.tileWidth;
        sprite.height = map.tileHeight;
        sprite.tint = hashTint(gid);
      }

      layerContainer.addChild(sprite);
    });
  }

  const collisionRects = map.collisions
    .filter(collision => collision.width > 0 && collision.height > 0)
    .map(collision => new Rectangle(collision.x, collision.y, collision.width, collision.height));

  const player = new Sprite(WHITE_TEXTURE);
  player.eventMode = "none";
  player.tint = 0x6ee7b7;
  player.width = map.tileWidth;
  player.height = map.tileHeight * 2;
  player.roundPixels = true;
  player.x = mapPixelWidth / 2 - player.width / 2;
  player.y = mapPixelHeight / 2 - player.height;
  scene.addChild(player);

  const footBounds = new Rectangle();
  const footHeight = map.tileHeight;
  const headHeight = player.height - footHeight;

  type Direction = "up" | "down" | "left" | "right";
  const pressed = new Set<Direction>();
  const normaliseKey = (key: string): Direction | null => {
    switch (key) {
      case "ArrowUp":
      case "w":
      case "W":
        return "up";
      case "ArrowDown":
      case "s":
      case "S":
        return "down";
      case "ArrowLeft":
      case "a":
      case "A":
        return "left";
      case "ArrowRight":
      case "d":
      case "D":
        return "right";
      default:
        return null;
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const mapped = normaliseKey(event.key);
    if (!mapped) {
      return;
    }

    pressed.add(mapped);
    event.preventDefault();
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    const mapped = normaliseKey(event.key);
    if (!mapped) {
      return;
    }

    pressed.delete(mapped);
    event.preventDefault();
  };

  window.addEventListener("keydown", handleKeyDown, { passive: false });
  window.addEventListener("keyup", handleKeyUp, { passive: false });

  const clampToMap = () => {
    const maxX = mapPixelWidth - player.width;
    const maxY = mapPixelHeight - player.height;
    const minY = -headHeight;

    player.x = Math.min(Math.max(player.x, 0), Math.max(0, maxX));
    player.y = Math.min(Math.max(player.y, minY), Math.max(minY, maxY));
  };

  const updateFootBounds = () => {
    footBounds.x = player.x;
    footBounds.y = player.y + headHeight;
    footBounds.width = player.width;
    footBounds.height = footHeight;
  };

  clampToMap();
  updateFootBounds();

  const moveAxis = (delta: number, axis: "x" | "y") => {
    if (delta === 0) {
      return;
    }

    if (axis === "x") {
      player.x += delta;
    } else {
      player.y += delta;
    }

    clampToMap();
    updateFootBounds();

    for (const rect of collisionRects) {
      if (!intersects(footBounds, rect)) {
        continue;
      }

      if (axis === "x") {
        player.x = delta > 0 ? rect.x - player.width : rect.x + rect.width;
      } else {
        if (delta > 0) {
          player.y = rect.y - player.height;
        } else {
          player.y = rect.y + rect.height - headHeight;
        }
      }

      clampToMap();
      updateFootBounds();
    }
  };

  const speed = 120;

  const updateSceneTransform = () => {
    if (!app.renderer) {
      return;
    }

    const pixelsPerTileX = Math.max(1, Math.floor(app.renderer.width / map.width));
    const pixelsPerTileY = Math.max(1, Math.floor(app.renderer.height / map.height));
    const pixelsPerTile = Math.max(1, Math.min(pixelsPerTileX, pixelsPerTileY));

    const scale = pixelsPerTile / map.tileWidth;
    scene.scale.set(scale);

    const scaledWidth = mapPixelWidth * scale;
    const scaledHeight = mapPixelHeight * scale;
    const offsetX = Math.round((app.renderer.width - scaledWidth) / 2);
    const offsetY = Math.round((app.renderer.height - scaledHeight) / 2);
    scene.position.set(offsetX, offsetY);
  };

  const tickerFn = (ticker: Ticker) => {
    const horizontal = Number(pressed.has("right")) - Number(pressed.has("left"));
    const vertical = Number(pressed.has("down")) - Number(pressed.has("up"));

    let dx = horizontal;
    let dy = vertical;

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy) || 1;
      dx /= length;
      dy /= length;
    }

    const deltaSeconds = ticker.deltaMS / 1000;
    moveAxis(dx * speed * deltaSeconds, "x");
    moveAxis(dy * speed * deltaSeconds, "y");

    updateSceneTransform();
  };

  updateSceneTransform();
  app.ticker.add(tickerFn);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    app.ticker.remove(tickerFn);
    scene.destroy({ children: true });

    for (const texture of tileTextureCache.values()) {
      texture.destroy();
    }
    tileTextureCache.clear();

    if (tilesheetTexture) {
      void Assets.unload(map.tileset.imageUrl);
    }
    pressed.clear();
  };
}

async function loadTiledMap(url: string): Promise<TiledMap> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Failed to request TMX map at ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to load TMX map at ${url}: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as any;
  const mapNode = parsed.map;

  if (!mapNode) {
    throw new Error("TMX file is missing <map> root node");
  }

  const width = Number(mapNode.width ?? 0);
  const height = Number(mapNode.height ?? 0);
  const tileWidth = Number(mapNode.tilewidth ?? 0);
  const tileHeight = Number(mapNode.tileheight ?? 0);

  if (!width || !height || !tileWidth || !tileHeight) {
    throw new Error("TMX map has invalid dimensions");
  }

  const layers = normaliseArray<RawLayer>(mapNode.layer).filter(
    layer => typeof layer?.data?.["#text"] === "string",
  );

  const parsedLayers: TileLayer[] = layers.map(layer => {
    const csv = (layer.data?.["#text"] ?? "").trim();
    const tiles = csv
      .split(/\s*,\s*/)
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value));

    return {
      name: layer.name,
      tiles,
    };
  });

  const objectGroup = normaliseArray<RawObjectGroup>(mapNode.objectgroup).find(
    group => group?.name === "Collision",
  );

  const collisions: CollisionBox[] = normaliseArray<RawCollision>(objectGroup?.object)
    .map(obj => ({
      id: Number(obj?.id ?? 0),
      x: Number(obj?.x ?? 0),
      y: Number(obj?.y ?? 0),
      width: Number(obj?.width ?? 0),
      height: Number(obj?.height ?? 0),
    }))
    .filter(obj => obj.width > 0 && obj.height > 0);

  const tilesetRef = normaliseArray<RawTilesetRef>(mapNode.tileset)[0];
  if (!tilesetRef) {
    throw new Error("TMX map does not declare a tileset");
  }

  const tilesetUrl = new URL(tilesetRef.source, url);
  let tilesetResponse: Response;
  try {
    tilesetResponse = await fetch(tilesetUrl);
  } catch (error) {
    throw new Error(`Failed to request TSX tileset at ${tilesetUrl}: ${(error as Error).message}`);
  }

  if (!tilesetResponse.ok) {
    throw new Error(`Failed to load TSX tileset at ${tilesetUrl}: ${tilesetResponse.status} ${tilesetResponse.statusText}`);
  }

  const tilesetXml = await tilesetResponse.text();
  const tilesetParsed = parser.parse(tilesetXml) as any;
  const tilesetNode = tilesetParsed.tileset;

  const imageNode = tilesetNode?.image;
  if (!imageNode?.source) {
    throw new Error("Tileset is missing image source");
  }

  const imageSource: string = imageNode.source;
  let imageUrl: string;
  try {
    imageUrl = new URL(imageSource, tilesetUrl).href;
  } catch (error) {
    console.warn("Could not resolve tileset image path, defaulting to data URL placeholder", error);
    imageUrl = createWhitePixelDataUrl();
  }

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    layers: parsedLayers,
    collisions,
    tileset: {
      firstGid: Number(tilesetRef.firstgid ?? 1),
      columns: Number(tilesetNode.columns ?? 0),
      tileWidth: Number(tilesetNode.tilewidth ?? tileWidth),
      tileHeight: Number(tilesetNode.tileheight ?? tileHeight),
      imageSource,
      imageUrl,
    },
  };
}

function normaliseArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function intersects(a: Rectangle, b: Rectangle) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function createWhitePixelDataUrl() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8/5+hHgAHggJ/lSYcnwAAAABJRU5ErkJggg==";
}
