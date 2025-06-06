import { Innertube, UniversalCache, YTNodes } from 'https://deno.land/x/youtubei@v13.4.0-deno/deno.ts';

const youtube = await Innertube.create({ retrieve_player: false, cache: new UniversalCache(
  // Enables persistent caching
  true, 
  // Path to the cache directory. The directory will be created if it doesn't exist
  './.cache' 
) });

const playlist = await youtube.getPlaylist(
  "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M",
);

const lastUpdated = playlist.info.last_updated;

const temporary_items = Promise.all(
  playlist.items.slice(0,5).map(item => item.as(YTNodes.PlaylistVideo)).map(async (item) => {
    try {
      const info = await youtube.music.getInfo(item.id);
      console.log(`Successfully retrieved info for ID ${item.id}, item details ${JSON.stringify(info)}`);
      return info;
    } catch (error) {
      console.error(`Failed to get info for ID ${item.id}:`, error);
      return null; // Or a placeholder object
    }
  })
);

const items = (await  temporary_items)
    .map((item) => item?.basic_info)
    .filter((item) => item != null)
    .map((item) => ({
    id: item.id,
    title: item.title,
    author: item.author,
    thumbnail: (item.thumbnail?.at(-2)?.url),
  }));
export { items, lastUpdated };
